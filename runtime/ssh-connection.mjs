import path from 'node:path';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import processTree from './platform/process-tree.js';
import { DomainError } from './store.mjs';
import { createConnectionRecovery } from './connection-recovery.mjs';
import { ownedProcess } from './platform/owned-process.mjs';
import { programExists } from './platform/tools.mjs';

const fault = (code, message) => new DomainError(code, message);
export function normalizeSshConfig(input) {
  const allowed = new Set(['kind', 'publicUrl', 'executable', 'host', 'user', 'sshPort', 'remotePort', 'identityFile']);
  if (!input || Object.keys(input).some(key => !allowed.has(key))) throw fault('invalid_connection', 'Unsupported SSH connection setting.');
  const url = new URL(input.publicUrl);
  if (url.protocol !== 'https:' || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash) throw fault('invalid_connection', 'SSH publicUrl must be an HTTPS /mcp URL without credentials.');
  if (!path.isAbsolute(input.executable || '') || /\.(cmd|bat|ps1)$/i.test(input.executable)) throw fault('invalid_executable', 'Select an absolute native OpenSSH executable.');
  if (typeof input.host !== 'string' || !(isIP(input.host) || /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9.])?$/.test(input.host))) throw fault('invalid_connection', 'SSH host must be a hostname or IP address.');
  if (typeof input.user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(input.user)) throw fault('invalid_connection', 'Choose an explicit SSH login user.');
  const sshPort = input.sshPort ?? 22, remotePort = input.remotePort ?? 18443;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) throw fault('invalid_connection', 'SSH ports are outside their allowed range.');
  if (input.identityFile !== undefined && !path.isAbsolute(input.identityFile)) throw fault('invalid_connection', 'identityFile must be an absolute path selected by the owner.');
  return { kind: 'ssh', publicUrl: url.href, executable: input.executable, host: input.host, user: input.user, sshPort, remotePort,
    ...(input.identityFile ? { identityFile: input.identityFile } : {}) };
}
export function sshArguments(config, localMcpUrl) {
  const target = new URL(localMcpUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.pathname !== '/mcp') throw fault('invalid_target', 'SSH must forward this runtime loopback port.');
  return ['-N', '-T', '-a', '-F', 'none', '-S', 'none',
    '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-p', String(config.sshPort), '-l', config.user,
    ...(config.identityFile ? ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    '-R', '127.0.0.1:' + config.remotePort + ':127.0.0.1:' + target.port, config.host];
}
export function createSshConnection({ config, localMcpUrl, instanceRoot, env = process.env,
  spawnImpl = spawn, terminateImpl = processTree.terminateProcessTree,
  owned = spawnImpl === spawn && instanceRoot ? ownedProcess(path.join(instanceRoot, 'connector.json')) : null } = {}) {
  const settings = normalizeSshConfig(config);
  const args = sshArguments(settings, localMcpUrl);
  let child = null, phase = 'stopped', diagnostic = '', lastError = null, queue = Promise.resolve();
  const serial = action => { const work = queue.then(action); queue = work.catch(() => {}); return work; };
  const recovery = createConnectionRecovery({ restart: () => start(),
    onError: error => { phase = 'failed'; lastError = {code:'ssh_restart_failed',message:error.message}; } });
  const status = () => ({ kind: 'ssh', phase, publicUrl: settings.publicUrl,
    host: settings.host, remotePort: settings.remotePort, ...(child?.pid ? { pid: child.pid } : {}),
    ...(diagnostic ? { diagnostic } : {}), ...(lastError ? { error: lastError } : {}),
    remoteMcpVerified: false, ...recovery.status() });
  function start() {
    return serial(async () => {
      if (child && !processTree.childExited(child)) { recovery.enable(); return status(); }
      if (!programExists(settings.executable)) throw fault('ssh_not_installed', 'OpenSSH was not found at the configured executable path.');
      await owned?.reap();
      diagnostic = ''; lastError = null; phase = 'starting';
      // Authentication stays in the native SSH agent/identity files. DevMate stores no SSH password or key.
      const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'ssh_auth_sock']);
      const environment = Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toLowerCase())));
      const proc = spawnImpl(settings.executable, args, { cwd: instanceRoot, env: environment,
        shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'] });
      child = proc;
      proc.stderr?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4000); });
      proc.on('error', error => { phase = 'failed'; lastError = { code: error.code || 'ssh_error', message: error.message }; });
      const departed = (code, signal) => {
        if (child !== proc) return;
        if (phase !== 'stopping') {
          phase = 'failed';
          owned?.forget();
          lastError = { code: 'ssh_exited', message: 'OpenSSH exited before an explicit stop.', exitCode: code, signal };
          recovery.unexpectedExit();
        }
      };
      proc.once('exit', departed);
      proc.once('close', (code, signal) => {
        if (child === proc && !processTree.childExited(proc)) departed(code, signal);
      });
      try { await new Promise((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); }); }
      catch (error) { child = null; throw error; }
      // A live process is distinct from a verified remote MCP endpoint.
      phase = 'process-running';
      void owned?.remember(proc.pid).catch(() => {});
      recovery.enable();
      return status();
    });
  }
  function stop() {
    recovery.disable();
    return serial(async () => {
      if (!child) { phase = 'stopped'; return status(); }
      phase = 'stopping';
      const termination = await terminateImpl(child);
      if (!termination.exitConfirmed) throw fault('shutdown_unconfirmed', 'The owned SSH process has not confirmed exit.');
      child = null; phase = 'stopped';
      owned?.forget();
      return status();
    });
  }
  return { start, stop, status, refresh(next) { env = next; } };
}
