import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import processTree from './platform/process-tree.js';
import { DomainError } from './store.mjs';
import { createConnectionRecovery } from './connection-recovery.mjs';
import { ownedProcess } from './platform/owned-process.mjs';
import { startable } from './platform/tools.mjs';

const fault = (code, message) => new DomainError(code, message);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Two ways to use cloudflared, both with DevMate owning only the connector process.
// cloudflare: a remotely managed tunnel. The public hostname and its route to this runtime's ingress port are
//   configured once in the Cloudflare dashboard, and a token identifies the tunnel.
// cloudflare-quick: a quick tunnel. No account, no token, no domain: Cloudflare hands out an address when the
//   connector starts, and a different one the next time. The address lives as long as that connector: so the
//   connector outlives the runtime (a restart, an update, an editor that starts it again, a crash) and the next
//   runtime takes it back, address and all. An explicit stop, another connection, a new address the owner asks for,
//   or a connector that lost its way to Cloudflare end it, and the next one is given another address.

// The record of a kept quick tunnel, apart from that of other connectors (OpenAI's tunnel client may run beside it),
// and the log cloudflared writes itself: a connector that outlives the runtime cannot write into a pipe of the runtime.
const QUICK_RECORD = 'quick-tunnel.json', QUICK_LOG = 'quick-tunnel.log', LOG_KEPT = 1024 * 1024;
// How often a quick tunnel is looked at, and how long it may hold no connection to Cloudflare before it is taken for
// lost (after a long sleep or a long time offline, Cloudflare may have given its address up while the process lives).
const LOOK_MS = 15000, LOST_MS = 120000;

/** The quick tunnel a runtime of this instance left running, as it was written down; null where there is none. */
export function keptQuickTunnel(instanceRoot) {
  try { const record = JSON.parse(fs.readFileSync(path.join(instanceRoot, QUICK_RECORD), 'utf8')); return Number.isInteger(record?.forwardsTo) ? record : null; }
  catch { return null; }
}
/** Ends a quick tunnel a runtime of this instance left running: the connection is another one now. */
export function endQuickTunnel(instanceRoot, options) { return ownedProcess(path.join(instanceRoot, QUICK_RECORD), options).reap(); }

// The key in the path of a quick tunnel's address: made once, kept in the instance. Taken away (devmate connect quick
// --new-address), a new one is made at the next start, and the tunnel kept for the old one is not taken back.
const KEY_FILE = 'quick-tunnel.key', KEY = /^[A-Za-z0-9_-]{32}$/;
export function quickTunnelKey(instanceRoot) {
  const file = path.join(instanceRoot, KEY_FILE);
  try { const kept = fs.readFileSync(file, 'utf8').trim(); if (KEY.test(kept)) return kept; } catch { /* none yet */ }
  const key = randomBytes(24).toString('base64url');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}
export function forgetQuickTunnelKey(instanceRoot) { fs.rmSync(path.join(instanceRoot, KEY_FILE), { force: true }); }

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
// The end of cloudflared's own log: what it said last, where it failed.
function tail(file, bytes = 4000) {
  try {
    const size = fs.statSync(file).size, length = Math.min(size, bytes), buffer = Buffer.alloc(length), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
    return buffer.toString('utf8');
  } catch { return ''; }
}
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
  spawnImpl = spawn, terminateImpl = processTree.terminateProcessTree, fetchImpl = globalThis.fetch, pickPort = freePort,
  lookMs = LOOK_MS, lostMs = LOST_MS, now = Date.now,
  // Only a process this module really started is written down; a test double has none to find again.
  owned = spawnImpl === spawn && instanceRoot ? ownedProcess(path.join(instanceRoot, config?.kind === 'cloudflare-quick' ? QUICK_RECORD : 'connector.json')) : null } = {}) {
  const settings = normalizeCloudflareConfig(config), quick = settings.kind === 'cloudflare-quick';
  const target = new URL(localMcpUrl), logFile = instanceRoot ? path.join(instanceRoot, QUICK_LOG) : null;
  // Which address of the runtime a kept quick tunnel serves: the key in its path is the runtime's to know, and only
  // a sign of it is written down. A new key (the owner asked for a new address) is a reason to start another one.
  const keyId = createHash('sha256').update(target.pathname).digest('base64url').slice(0, 16);
  // assigned: the address a quick tunnel was given for as long as this connector lives. since: when it was given.
  // A connector taken back from a runtime before is { pid, adopted: true }: no process object, no events of its own.
  let child = null, phase = 'stopped', diagnostic = '', lastError = null, connections = 0, metrics = null, assigned = null, since = null, queue = Promise.resolve();
  let lookTimer = null, emptySince = null, misses = 0;
  const publicUrl = () => quick ? assigned : settings.publicUrl;
  const serial = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const recovery = createConnectionRecovery({ restart: () => start(),
    onError: error => { phase = 'failed'; lastError = { code: 'cloudflared_restart_failed', message: error.message }; } });
  const alive = () => child && (child.adopted || !processTree.childExited(child));
  const snapshot = () => ({ kind: settings.kind, phase, ...(publicUrl() ? { publicUrl: publicUrl() } : {}),
    // The dashboard route for the public hostname must point at this local service.
    ...(quick ? { temporaryAddress: true, ...(assigned && since ? { addressSince: since } : {}), ...(child?.adopted ? { adopted: true } : {}) } : { routeService: 'http://127.0.0.1:' + target.port }), edgeConnections: connections,
    ...(child?.pid ? { pid: child.pid } : {}), ...(diagnostic ? { diagnostic } : {}), ...(lastError ? { error: lastError } : {}),
    remoteMcpVerified: false, ...recovery.status() });
  const ask = async (address, what) => { const response = await fetchImpl(address + what, { redirect: 'error', signal: AbortSignal.timeout(2000) }); return { ok: response.ok, body: await response.json() }; };
  // The address cloudflared was given, from cloudflared itself.
  const hostnameOf = async address => { try { const { body } = await ask(address, '/quicktunnel'); return typeof body?.hostname === 'string' && /^[a-z0-9-]+\.trycloudflare\.com$/.test(body.hostname) ? body.hostname : null; } catch { return null; } };
  // cloudflared knows how many connections to the Cloudflare edge it holds right now. Its log only says
  // when one was made; its own readiness endpoint also knows when they were lost.
  async function status() {
    if (metrics && alive() && ['connecting', 'connected'].includes(phase)) {
      try {
        const ready = await ask(metrics, '/ready');
        connections = Number(ready.body.readyConnections) || 0;
        if (['connecting', 'connected'].includes(phase)) phase = ready.ok && connections > 0 ? 'connected' : 'connecting';
      } catch { /* The log-derived state stands until the endpoint answers. */ }
    }
    if (quick && logFile) diagnostic = tail(logFile);
    return snapshot();
  }
  // A quick tunnel is looked at now and then: whether it holds a connection to Cloudflare, and whether a connector
  // taken back from an earlier runtime is still there (it sends this runtime no word when it ends).
  function watch() {
    clearInterval(lookTimer); emptySince = now(); misses = 0;
    lookTimer = setInterval(() => void look(), lookMs); lookTimer.unref?.();
  }
  async function look() {
    const watched = child;
    if (!watched || phase === 'stopping' || !metrics) return;
    let ready = null;
    try { ready = await ask(metrics, '/ready'); } catch { /* no answer */ }
    if (child !== watched) return;
    if (!ready) {
      if (watched.adopted && ++misses >= 2) return lose(watched, 'cloudflared_exited', 'cloudflared, kept from an earlier start, is not there any more.');
      return;
    }
    misses = 0; connections = Number(ready.body?.readyConnections) || 0;
    if (connections > 0) { emptySince = null; phase = 'connected'; return; }
    if (phase === 'connected') phase = 'connecting';
    emptySince ??= now();
    if (now() - emptySince >= lostMs) return lose(watched, 'tunnel_lost', 'cloudflared held no connection to Cloudflare for ' + Math.round(lostMs / 60000) + ' minutes (after a long sleep or a long time offline, Cloudflare may have given the address up). It is started again, under a new address.');
  }
  // A quick tunnel that is not there or not reached any more is ended and started again, as after an unexpected exit.
  async function lose(lost, code, message) {
    if (child !== lost) return;
    child = null; clearInterval(lookTimer);
    phase = 'failed'; connections = 0; metrics = null; assigned = null; since = null;
    lastError = { code, message };
    try { if (lost.adopted) await owned?.reap(); else { await terminateImpl(lost); owned?.forget(); } } catch { /* the next start ends what is written down */ }
    recovery.unexpectedExit();
  }
  // A quick tunnel an earlier runtime of this instance left running, where it is still the one this runtime would
  // start: the same cloudflared, forwarding to this runtime's port, for this runtime's key.
  async function adopt() {
    if (!quick || !owned?.adopt) return false;
    const record = await owned.adopt(kept => kept.kind === 'cloudflare-quick' && kept.executable === settings.executable && kept.forwardsTo === Number(target.port)
      && kept.keyId === keyId && typeof kept.metrics === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(kept.metrics));
    const hostname = record ? await hostnameOf(record.metrics) : null;
    if (!hostname) return false;
    child = { pid: record.pid, adopted: true }; metrics = record.metrics; assigned = 'https://' + hostname + target.pathname;
    since = typeof record.since === 'string' ? record.since : null; diagnostic = ''; lastError = null; connections = 0; phase = 'connecting';
    return true;
  }
  const remembered = proc => owned?.remember(proc.pid, { kind: 'cloudflare-quick', executable: settings.executable, forwardsTo: Number(target.port), keyId, metrics, ...(since ? { since } : {}) }) ?? Promise.resolve(false);
  // The address a new quick tunnel is given, asked of cloudflared until it has one; written down with the connector.
  async function learn(proc) {
    for (const end = now() + 60000; child === proc && !assigned && now() < end; await new Promise(resolve => setTimeout(resolve, 500))) {
      const hostname = metrics ? await hostnameOf(metrics) : null;
      if (hostname && child === proc) { assigned = 'https://' + hostname + target.pathname; since = new Date(now()).toISOString(); }
    }
    if (child === proc && assigned) await remembered(proc).catch(() => {});
  }
  function start() {
    return serial(async () => {
      if (alive()) { recovery.enable(); return status(); }
      if (await adopt()) { watch(); recovery.enable(); return status(); }
      if (!startable(settings.executable)) throw fault('cloudflared_not_installed', 'cloudflared was not found at the configured executable path.');
      const token = quick ? '' : env[settings.tokenEnv];
      if (!quick && (typeof token !== 'string' || !token.trim())) throw fault('missing_credential', 'Missing tunnel token environment variable: ' + settings.tokenEnv);
      await owned?.reap();
      diagnostic = ''; lastError = null; connections = 0; metrics = null; assigned = null; since = null; phase = 'starting';
      const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile',
        'programdata', 'https_proxy', 'http_proxy', 'no_proxy', 'ssl_cert_file']);
      const environment = Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toLowerCase())));
      if (quick) {
        // A connector that outlives the runtime: a process of its own (no console window on Windows), with nothing
        // of the runtime's held open, its log in a file, its metrics on a port that is written down with it.
        const port = await pickPort();
        metrics = 'http://127.0.0.1:' + port;
        try { if (fs.statSync(logFile).size > LOG_KEPT) fs.renameSync(logFile, logFile + '.1'); } catch { /* none yet */ }
        const proc = spawnImpl(settings.executable, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:' + port, ...(logFile ? ['--logfile', logFile] : []), '--url', 'http://127.0.0.1:' + target.port],
          { cwd: instanceRoot, env: environment, shell: false, windowsHide: true, detached: true, stdio: 'ignore' });
        child = proc;
        proc.on('error', error => { phase = 'failed'; lastError = { code: error.code || 'cloudflared_error', message: error.message }; });
        const departed = (code, signal) => {
          if (child !== proc || phase === 'stopping') return;
          child = null; clearInterval(lookTimer);
          phase = 'failed'; connections = 0; metrics = null; assigned = null; since = null;
          owned?.forget();
          lastError = { code: 'cloudflared_exited', message: 'cloudflared exited before an explicit stop.', exitCode: code, signal };
          recovery.unexpectedExit();
        };
        proc.once('exit', departed);
        try { await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); }); }
        catch (error) { child = null; throw error; }
        proc.unref?.();
        if (phase === 'starting') phase = 'connecting';
        // Written down at once: a runtime that stops before the address is known leaves no connector nobody knows of.
        await remembered(proc).catch(() => {});
        void learn(proc);
        watch();
        recovery.enable();
        return snapshot();
      }
      // The token travels in the environment, never in the visible process arguments.
      // Its metrics server is pinned to loopback on a free port; the default may bind every interface.
      const proc = spawnImpl(settings.executable, ['tunnel', '--no-autoupdate', '--metrics', '127.0.0.1:0', 'run'], { cwd: instanceRoot,
        env: { ...environment, TUNNEL_TOKEN: token.trim() }, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
      child = proc;
      proc.stderr?.on('data', chunk => {
        const text = String(chunk);
        diagnostic = (diagnostic + text).slice(-4000);
        if (child !== proc || phase === 'stopping') return;
        const announced = diagnostic.match(/Starting metrics server on (127\.0\.0\.1:\d{1,5})\/metrics/);
        if (announced) metrics = 'http://' + announced[1];
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
  // keep: the runtime stops in order to start again (a restart, an update) or because it failed. A quick tunnel is
  // then left running, written down, for the next runtime to take back with its address. Any other stop ends it.
  function stop({ keep = false } = {}) {
    recovery.disable();
    return serial(async () => {
      clearInterval(lookTimer);
      if (!child) { phase = 'stopped'; return snapshot(); }
      if (quick && keep) { child = null; phase = 'stopped'; connections = 0; metrics = null; assigned = null; since = null; return snapshot(); }
      phase = 'stopping';
      if (child.adopted) await owned?.reap();
      else {
        const termination = await terminateImpl(child);
        if (!termination.exitConfirmed) throw fault('shutdown_unconfirmed', 'The owned cloudflared process has not confirmed exit.');
        owned?.forget();
      }
      child = null; phase = 'stopped'; connections = 0; metrics = null; assigned = null; since = null;
      return snapshot();
    });
  }
  return { start, stop, status, publicUrl, refresh(next) { env = next; } };
}
