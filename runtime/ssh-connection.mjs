import path from 'node:path';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import processTree from './platform/process-tree.js';
import { DomainError } from './store.mjs';
import { createConnectionRecovery } from './connection-recovery.mjs';
import { ownedProcess } from './platform/owned-process.mjs';
import { startable } from './platform/tools.mjs';

const fault = (code, message) => new DomainError(code, message);
export function normalizeSshConfig(input) {
  const allowed = new Set(['kind', 'publicUrl', 'executable', 'host', 'user', 'sshPort', 'remotePort', 'identityFile', 'relay']);
  if (!input || Object.keys(input).some(key => !allowed.has(key))) throw fault('invalid_connection', 'Unsupported SSH connection setting.');
  const url = new URL(input.publicUrl);
  // The path is /mcp, or /mcp/<key> where the server forwards only a path nobody can guess (devmate relay setup).
  if (url.protocol !== 'https:' || !/^\/mcp(?:\/[A-Za-z0-9_-]{32,64})?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) throw fault('invalid_connection', 'SSH publicUrl must be an HTTPS /mcp URL without credentials.');
  if (input.relay !== undefined && typeof input.relay !== 'boolean') throw fault('invalid_connection', 'relay is true for a server set up with devmate relay setup.');
  if (!path.isAbsolute(input.executable || '') || /\.(cmd|bat|ps1)$/i.test(input.executable)) throw fault('invalid_executable', 'Select an absolute native OpenSSH executable.');
  if (typeof input.host !== 'string' || !(isIP(input.host) || /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9.])?$/.test(input.host))) throw fault('invalid_connection', 'SSH host must be a hostname or IP address.');
  if (typeof input.user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(input.user)) throw fault('invalid_connection', 'Choose an explicit SSH login user.');
  const sshPort = input.sshPort ?? 22, remotePort = input.remotePort ?? 18443;
  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1024 || remotePort > 65535) throw fault('invalid_connection', 'SSH ports are outside their allowed range.');
  if (input.identityFile !== undefined && !path.isAbsolute(input.identityFile)) throw fault('invalid_connection', 'identityFile must be an absolute path selected by the owner.');
  return { kind: 'ssh', publicUrl: url.href, executable: input.executable, host: input.host, user: input.user, sshPort, remotePort,
    ...(input.identityFile ? { identityFile: input.identityFile } : {}), ...(input.relay ? { relay: true } : {}) };
}
export function sshArguments(config, localMcpUrl) {
  const target = new URL(localMcpUrl);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || !target.pathname.startsWith('/mcp')) throw fault('invalid_target', 'SSH must forward this runtime loopback port.');
  return ['-N', ...sshLogin(config), '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-R', '127.0.0.1:' + config.remotePort + ':127.0.0.1:' + target.port, config.host];
}
const sshLogin = config => ['-T', '-a', '-F', 'none', '-S', 'none', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
  '-p', String(config.sshPort), '-l', config.user, ...(config.identityFile ? ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes'] : [])];
// A relay answers only to the addresses on its list, and this computer's own address is one of them so that the
// route can be checked from here. That address changes; the relay is told the current one at every connection.
export const ownerAddressArguments = config => [...sshLogin(config), config.host, '/usr/local/lib/devmate/allow-owner'];
export function createSshConnection({ config, localMcpUrl, instanceRoot, env = process.env,
  spawnImpl = spawn, terminateImpl = processTree.terminateProcessTree, tellWaitMs = 5000,
  note = line => process.stderr.write(new Date().toISOString() + ' connection: ' + line + '\n'),
  owned = spawnImpl === spawn && instanceRoot ? ownedProcess(path.join(instanceRoot, 'connector.json')) : null } = {}) {
  const settings = normalizeSshConfig(config);
  const args = sshArguments(settings, localMcpUrl);
  // telling: the login that tells a relay this computer's address, while it runs.
  let child = null, telling = null, phase = 'stopped', diagnostic = '', lastError = null, queue = Promise.resolve();
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
      if (!startable(settings.executable)) throw fault('ssh_not_installed', 'OpenSSH was not found at the configured executable path.');
      await owned?.reap();
      diagnostic = ''; lastError = null; phase = 'starting';
      // Authentication stays in the native SSH agent/identity files. DevMate stores no SSH password or key.
      const inherited = new Set(['path', 'pathext', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'userprofile', 'ssh_auth_sock']);
      const environment = Object.fromEntries(Object.entries(env).filter(([name]) => inherited.has(name.toLowerCase())));
      // Best effort and bounded: a relay that cannot be told still forwards, and the check then says what is the matter.
      // The start waits a few seconds for it, so that the check that follows finds this computer on the relay's list,
      // and no longer: a server that does not answer held the start of the whole runtime up for as long as a start is
      // given at all, local use included. The login goes on by itself until its own limit, and stays this
      // connection's own: a stop ends it (see stop), and how it ended is written down where its being late was.
      if (settings.relay) await new Promise(resolve => {
        let told, late = false;
        try { told = spawnImpl(settings.executable, ownerAddressArguments(settings), { cwd: instanceRoot, env: environment, shell: false, windowsHide: true, stdio: 'ignore' }); }
        catch { return resolve(); }
        telling = told;
        const limit = setTimeout(() => { try { told.kill?.(); } catch {} }, 20000);
        const waited = setTimeout(() => { late = true; note('the relay at ' + settings.host + ' has not answered for ' + Math.round(tellWaitMs / 1000) + ' seconds; the start goes on without it. Where this computer\'s address has changed since the relay was last told, the check of the route from here fails until it is.'); told.unref?.(); resolve(); }, tellWaitMs);
        limit.unref?.();
        const done = (code, signal) => {
          clearTimeout(limit); clearTimeout(waited);
          if (telling === told) telling = null;
          if (late) note('the relay at ' + settings.host + (code === 0 ? ' has been told this computer\'s address after all.' : ' was not told this computer\'s address (' + (code instanceof Error ? code.message : signal ? 'the login was ended' : 'the login ended with code ' + code) + ').'));
          resolve();
        };
        told.once('error', done); told.once('exit', done);
      });
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
    // A login to the relay that is still on its way is not left behind by a stop or a restart.
    if (telling) { try { telling.kill?.(); } catch {} }
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
