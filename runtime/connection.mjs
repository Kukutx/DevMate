import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import processTree from './platform/process-tree.js';
import { instanceDirectory, localControlUrl } from './client.mjs';
import { createSshConnection, normalizeSshConfig } from './ssh-connection.mjs';
import { createCloudflareConnection, normalizeCloudflareConfig } from './cloudflare-connection.mjs';
import { createConnectionRecovery } from './connection-recovery.mjs';
import { ownedProcess } from './platform/owned-process.mjs';

const { childExited, terminateProcessTree } = processTree;
const executeFile = promisify(execFile);

export const TUNNEL_CLIENT_SETUP = Object.freeze({
  download: 'https://platform.openai.com/settings/organization/tunnels',
  releases: 'https://github.com/openai/tunnel-client/releases',
  guide: 'https://github.com/openai/tunnel-client/blob/master/docs/onboarding.md',
  inspectCommand: ['--version'],
  note: 'Install the official executable for this operating system in a versioned directory. Select its absolute path explicitly; changing the path does not restart a running connection.'
});

function httpTarget(value, { publicOnly = false } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('MCP target must be an HTTP URL without credentials, query, or fragment');
  if (publicOnly && url.protocol !== 'https:') throw new Error('External MCP target must use HTTPS');
  return url.href;
}

export function normalizeConnectionConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Connection configuration must be an object');
  const kind = value.kind || 'local';
  if (kind === 'ssh') return normalizeSshConfig(value);
  if (kind === 'cloudflare') return normalizeCloudflareConfig(value);
  const allowed = {
    local: new Set(['kind']),
    'external-https': new Set(['kind', 'url']),
    'openai-tunnel': new Set(['kind', 'tunnelId', 'executable', 'runtimeKeyEnv'])
  }[kind];
  if (!allowed) throw new Error('Connection kind must be local, openai-tunnel, cloudflare, external-https, or ssh');
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unsupported connection setting: ${key}`);
  if (kind === 'local') return { kind };
  if (kind === 'external-https') return { kind, url: httpTarget(value.url, { publicOnly: true }) };
  const tunnelId = String(value.tunnelId || '').trim();
  const executable = String(value.executable || '').trim();
  const runtimeKeyEnv = String(value.runtimeKeyEnv || 'CONTROL_PLANE_API_KEY');
  if (!/^tunnel_[A-Za-z0-9]+$/.test(tunnelId)) throw new Error('A valid OpenAI tunnel_id is required');
  if (!path.isAbsolute(executable) || /\.(cmd|bat|ps1)$/i.test(executable)) throw new Error('Select the absolute official tunnel-client executable, not a shell script');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(runtimeKeyEnv)) throw new Error('runtimeKeyEnv must name an environment variable');
  return { kind, tunnelId, executable, runtimeKeyEnv };
}

export async function inspectTunnelClient({ executable, execFileImpl = executeFile } = {}) {
  if (!path.isAbsolute(String(executable || '')) || /\.(cmd|bat|ps1)$/i.test(executable)) throw new Error('An absolute native tunnel-client executable is required');
  let result;
  try {
    result = await execFileImpl(executable, ['--version'], {
      timeout: 10000, maxBuffer: 16384, windowsHide: true, shell: false
    });
  } catch {
    throw new Error('Official tunnel-client version check failed; verify the selected executable');
  }
  const version = String(result.stdout || '').match(/\bv?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/)?.[1];
  if (!version) throw new Error('The executable did not report a tunnel-client version');
  return { executable, version };
}

export function createConnection({
  config = { kind: 'local' }, localMcpUrl, instanceRoot,
  env = process.env, spawnImpl = spawn, fetchImpl = globalThis.fetch,
  terminateImpl = terminateProcessTree
} = {}) {
  const settings = normalizeConnectionConfig(config);
  if (settings.kind === 'ssh') return createSshConnection({ config: settings, localMcpUrl, instanceRoot, env, spawnImpl, terminateImpl });
  if (settings.kind === 'cloudflare') return createCloudflareConnection({ config: settings, localMcpUrl, instanceRoot, env, spawnImpl, terminateImpl, fetchImpl });
  const localUrl = httpTarget(localMcpUrl);
  const healthFile = path.join(instanceDirectory(instanceRoot), 'tunnel-health.url');
  // Only a process this module really started is written down; a test double has none to find again.
  const owned = spawnImpl === spawn && instanceRoot ? ownedProcess(path.join(instanceDirectory(instanceRoot), 'connector.json')) : null;
  let child = null;
  let phase = 'stopped';
  let exitCode = null;
  let diagnostic = '';
  let failed = false;
  let queue = Promise.resolve();
  const serial = operation => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const recovery = createConnectionRecovery({ restart: () => start(),
    onError: () => { failed = true; phase = 'failed'; } });

  function snapshot() {
    return {
      kind: settings.kind, phase,
      ...(settings.kind === 'openai-tunnel' ? { tunnelId: settings.tunnelId } : {}),
      ...(settings.kind === 'external-https' ? { url: settings.url } : { localMcpUrl: localUrl }),
      ...(child?.pid ? { pid: child.pid } : {}),
      ...(exitCode !== null ? { exitCode } : {}), ...(diagnostic ? { diagnostic } : {}),
      remoteMcpVerified: false, ...recovery.status()
    };
  }

  async function status() {
    if (settings.kind !== 'openai-tunnel' || !child || childExited(child) || failed) return snapshot();
    let healthUrl;
    try {
      const stat = fs.statSync(healthFile);
      if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid tunnel health URL file');
      healthUrl = localControlUrl(fs.readFileSync(healthFile, 'utf8').trim());
    } catch {
      // No health address yet, or one that is not this computer: the state so far stands.
      return snapshot();
    }
    try {
      const response = await fetchImpl(new URL('/readyz', healthUrl), {
        redirect: 'error', signal: AbortSignal.timeout(2000)
      });
      await response.body?.cancel();
      phase = response.ok ? 'relay-ready' : 'connecting';
    } catch {
      phase = 'connecting';
    }
    return snapshot();
  }

  function start() {
    return serial(async () => {
      if (child && !childExited(child)) return status();
      exitCode = null;
      failed = false;
      if (settings.kind === 'local') { phase = 'local'; return snapshot(); }
      if (settings.kind === 'external-https') { phase = 'configured'; return snapshot(); }
      if (!fs.statSync(settings.executable, { throwIfNoEntry: false })?.isFile()) throw new Error('Official tunnel-client executable is not installed at the selected path');
      const runtimeKey = env[settings.runtimeKeyEnv];
      if (typeof runtimeKey !== 'string' || !runtimeKey.trim()) throw new Error(`Missing runtime key environment variable: ${settings.runtimeKeyEnv}`);
      fs.mkdirSync(path.dirname(healthFile), { recursive: true, mode: 0o700 });
      fs.rmSync(healthFile, { force: true });
      await owned?.reap();
      const args = [
        'run',
        '--control-plane.tunnel-id', settings.tunnelId,
        '--mcp.server-url', localUrl,
        '--health.listen-addr', '127.0.0.1:0',
        '--health.url-file', healthFile
      ];
      phase = 'connecting';
      const inherited = new Set(['path','pathext','systemroot','windir','temp','tmp','home','userprofile',
        'appdata','localappdata','programdata','https_proxy','http_proxy','no_proxy',
        'ssl_cert_file','node_extra_ca_certs']);
      const environment = Object.fromEntries(Object.entries(env)
        .filter(([name]) => inherited.has(name.toLowerCase())));
      child = spawnImpl(settings.executable, args, {
        cwd: path.dirname(healthFile), shell: false, windowsHide: true,
        env: { ...environment, CONTROL_PLANE_API_KEY: runtimeKey },
        stdio: ['ignore', 'ignore', 'pipe']
      });
      const proc = child;
      // What the connector says when it cannot connect is the only explanation there is.
      diagnostic = '';
      proc.stderr?.on('data', chunk => { if (child === proc) diagnostic = (diagnostic + String(chunk)).slice(-4000); });
      proc.on('error', () => { failed = true; phase = 'failed'; });
      const departed = code => {
        if (child !== proc) return;
        exitCode = code;
        if (phase !== 'stopping') {
          phase = 'failed';
          owned?.forget();
          recovery.unexpectedExit();
        } else phase = 'stopped';
      };
      proc.once('exit', departed);
      proc.once('close', code => { if (child === proc && !childExited(proc)) departed(code); });
      void owned?.remember(proc.pid).catch(() => {});
      recovery.enable();
      return snapshot();
    });
  }

  function stop() {
    recovery.disable();
    return serial(async () => {
      if (!child || childExited(child)) { child = null; phase = 'stopped'; return snapshot(); }
      phase = 'stopping';
      const stopped = await terminateImpl(child);
      if (!stopped.exitConfirmed) throw new Error('Owned tunnel-client has not stopped');
      child = null;
      phase = 'stopped';
      owned?.forget();
      fs.rmSync(healthFile, { force: true });
      return snapshot();
    });
  }

  return { start, stop, status, config: settings, refresh(next) { env = next; } };
}
