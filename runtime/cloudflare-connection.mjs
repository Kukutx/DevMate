import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import processTree from './platform/process-tree.js';
import { DomainError } from './store.mjs';
import { createConnectionRecovery } from './connection-recovery.mjs';
import { ownedProcess } from './platform/owned-process.mjs';

const fault = (code, message) => new DomainError(code, message);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Two ways to use cloudflared, both with DevMate owning only the connector process.
// cloudflare: a remotely managed tunnel. The public hostname and its route to this runtime's ingress port are
//   configured once in the Cloudflare dashboard, and a token identifies the tunnel.
// cloudflare-quick: a quick tunnel. No account, no token, no domain: Cloudflare hands out an address when the
//   connector starts, and a different one the next time. It is for getting connected at once.
export function normalizeCloudflareConfig(input) {
  if (input?.kind === 'cloudflare-quick') {
    if (Object.keys(input).some(key => !['kind', 'executable'].includes(key))) throw fault('invalid_connection', 'A quick tunnel takes only the cloudflared executable.');
    if (!path.isAbsolute(input.executable || '') || /\.(cmd|bat|ps1)$/i.test(input.executable)) throw fault('invalid_executable', 'Select the absolute cloudflared executable.');
    return { kind: 'cloudflare-quick', executable: input.executable };
  }
  const allowed = new Set(['kind', 'publicUrl', 'executable', 'tokenEnv']);
  if (!input || Object.keys(input).some(key => !allowed.has(key))) throw fault('invalid_connection', 'Unsupported Cloudflare connection setting.');
  let url;
  try { url = new URL(input.publicUrl); } catch { throw fault('invalid_connection', 'Cloudflare publicUrl must be the HTTPS /mcp URL of your tunnel hostname.'); }
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw fault('invalid_connection', 'Cloudflare publicUrl must be an HTTPS /mcp URL without credentials.');
  if (!path.isAbsolute(input.executable || '') || /\.(cmd|bat|ps1)$/i.test(input.executable)) throw fault('invalid_executable', 'Select the absolute cloudflared executable.');
  const tokenEnv = input.tokenEnv ?? 'CLOUDFLARE_TUNNEL_TOKEN';
  if (typeof tokenEnv !== 'string' || !ENV_NAME.test(tokenEnv)) throw fault('invalid_connection', 'tokenEnv must name an environment variable.');
  return { kind: 'cloudflare', publicUrl: url.href, executable: input.executable, tokenEnv };
}

export function createCloudflareConnection({ config, localMcpUrl, instanceRoot, env = process.env,
  spawnImpl = spawn, terminateImpl = processTree.terminateProcessTree, fetchImpl = globalThis.fetch,
  // Only a process this module really started is written down; a test double has none to find again.
  owned = spawnImpl === spawn && instanceRoot ? ownedProcess(path.join(instanceRoot, 'connector.json')) : null } = {}) {
  const settings = normalizeCloudflareConfig(config), quick = settings.kind === 'cloudflare-quick';
  const target = new URL(localMcpUrl);
  // assigned: the address a quick tunnel was given for as long as this connector lives.
  let child = null, phase = 'stopped', diagnostic = '', lastError = null, connections = 0, metrics = null, assigned = null, queue = Promise.resolve();
  const publicUrl = () => quick ? assigned : settings.publicUrl;
  const serial = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const recovery = createConnectionRecovery({ restart: () => start(),
    onError: error => { phase = 'failed'; lastError = { code: 'cloudflared_restart_failed', message: error.message }; } });
  const snapshot = () => ({ kind: settings.kind, phase, ...(publicUrl() ? { publicUrl: publicUrl() } : {}),
    // The dashboard route for the public hostname must point at this local service.
    ...(quick ? { temporaryAddress: true } : { routeService: 'http://127.0.0.1:' + target.port }), edgeConnections: connections,
    ...(child?.pid ? { pid: child.pid } : {}), ...(diagnostic ? { diagnostic } : {}), ...(lastError ? { error: lastError } : {}),
    remoteMcpVerified: false, ...recovery.status() });
  // cloudflared knows how many connections to the Cloudflare edge it holds right now. Its log only says
  // when one was made; its own readiness endpoint also knows when they were lost.
  async function status() {
    if (metrics && child && !processTree.childExited(child) && ['connecting', 'connected'].includes(phase)) {
      try {
        const response = await fetchImpl(metrics + '/ready', { redirect: 'error', signal: AbortSignal.timeout(2000) });
        const ready = await response.json();
        connections = Number(ready.readyConnections) || 0;
        if (['connecting', 'connected'].includes(phase)) phase = response.ok && connections > 0 ? 'connected' : 'connecting';
      } catch { /* The log-derived state stands until the endpoint answers. */ }
    }
    return snapshot();
  }
  function start() {
    return serial(async () => {
      if (child && !processTree.childExited(child)) { recovery.enable(); return status(); }
      if (!fs.statSync(settings.executable, { throwIfNoEntry: false })?.isFile()) throw fault('cloudflared_not_installed', 'cloudflared was not found at the configured executable path.');
      const token = quick ? '' : env[settings.tokenEnv];
      if (!quick && (typeof token !== 'string' || !token.trim())) throw fault('missing_credential', 'Missing tunnel token environment variable: ' + settings.tokenEnv);
      await owned?.reap();
      diagnostic = ''; lastError = null; connections = 0; metrics = null; assigned = null; phase = 'starting';
      const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile',
        'programdata', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file']);
      const environment = Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toLowerCase())));
      // The token travels in the environment, never in the visible process arguments.
      // Its metrics server is pinned to loopback on a free port; the default may bind every interface.
      // A quick tunnel is told where to forward to; a managed one learns it from the dashboard.
      const proc = spawnImpl(settings.executable, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', ...(quick ? ['--url', 'http://127.0.0.1:' + target.port] : ['run'])], { cwd: instanceRoot,
        env: quick ? environment : { ...environment, TUNNEL_TOKEN: token.trim() }, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
      child = proc;
      proc.stderr?.on('data', chunk => {
        const text = String(chunk);
        diagnostic = (diagnostic + text).slice(-4000);
        if (child !== proc || phase === 'stopping') return;
        const announced = diagnostic.match(/Starting metrics server on (127\.0\.0\.1:\d{1,5})\/metrics/);
        if (announced) metrics = 'http://' + announced[1];
        if (quick && !assigned) { const given = diagnostic.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/); if (given) assigned = given[0] + '/mcp'; }
        const registered = text.match(/Registered tunnel connection/g)?.length || 0, lost = text.match(/Unregistered tunnel connection/g)?.length || 0;
        connections = Math.max(0, connections + registered - lost);
        if (registered || lost) phase = connections > 0 ? 'connected' : 'connecting';
      });
      proc.on('error', error => { phase = 'failed'; lastError = { code: error.code || 'cloudflared_error', message: error.message }; });
      const departed = (code, signal) => {
        if (child !== proc || phase === 'stopping') return;
        phase = 'failed'; connections = 0; metrics = null; assigned = null;
        owned?.forget();
        lastError = { code: 'cloudflared_exited', message: 'cloudflared exited before an explicit stop.', exitCode: code, signal };
        recovery.unexpectedExit();
      };
      proc.once('exit', departed);
      proc.once('close', (code, signal) => { if (child === proc && !processTree.childExited(proc)) departed(code, signal); });
      try { await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); }); }
      catch (error) { child = null; throw error; }
      // A running connector is not yet a verified public MCP endpoint.
      if (phase === 'starting') phase = 'connecting';
      void owned?.remember(proc.pid).catch(() => {});
      recovery.enable();
      return snapshot();
    });
  }
  function stop() {
    recovery.disable();
    return serial(async () => {
      if (!child) { phase = 'stopped'; return snapshot(); }
      phase = 'stopping';
      const termination = await terminateImpl(child);
      if (!termination.exitConfirmed) throw fault('shutdown_unconfirmed', 'The owned cloudflared process has not confirmed exit.');
      child = null; phase = 'stopped'; connections = 0; metrics = null; assigned = null;
      owned?.forget();
      return snapshot();
    });
  }
  return { start, stop, status, publicUrl, refresh(next) { env = next; } };
}
