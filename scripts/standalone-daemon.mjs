import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import network from '../host/runtime/network.js';
import { configFile, readConfig, standaloneStateSeparation } from './standalone-runtime.mjs';

const { healthAt, healthMatches } = network;
const CLI_OWNER_PREFIX = 'cli-daemon-';
const START_TIMEOUT_MS = 30000;
const STOP_TIMEOUT_MS = 10000;
const TASKKILL_TIMEOUT_MS = 2000;
const GRACEFUL_STOP_MS = 3000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function boundedTimeout(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(numeric) || numeric < 1000 || numeric > 120000) {
    throw new Error(`${label} must be an integer from 1000 to 120000`);
  }
  return numeric;
}

function configuredWorkspaceRoots(config) {
  return [
    ...(Array.isArray(config?.workspaces) ? config.workspaces.map(item => item?.root) : []),
    ...(Array.isArray(config?.trustedWritableRoots) ? config.trustedWritableRoots.map(item => item?.root || item?.path || item) : [])
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
}

function runtimeFiles(file) {
  const stateRoot = path.join(path.dirname(path.resolve(file)), 'state');
  return {
    stateRoot,
    lock: path.join(stateRoot, 'gateway.lock'),
    log: path.join(stateRoot, 'standalone-gateway.log')
  };
}

function readLock(file) {
  const { lock } = runtimeFiles(file);
  try {
    const stat = fs.statSync(lock, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 64 * 1024) return null;
    const value = JSON.parse(fs.readFileSync(lock, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function cliOwnedLock(lock, file) {
  return !!lock &&
    String(lock.runtimeOwnerId || '').startsWith(CLI_OWNER_PREFIX) &&
    path.resolve(String(lock.configPath || '')) === path.resolve(file) &&
    Number.isInteger(Number(lock.pid)) && Number(lock.pid) > 0;
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function runTaskkill(pid, force, timeoutMs = TASKKILL_TIMEOUT_MS) {
  return new Promise(resolve => {
    let killer;
    try {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: error?.message || String(error) });
      return;
    }
    let settled = false;
    let timer = null;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killer.off?.('error', onError);
      killer.off?.('close', onClose);
      resolve(result);
    };
    const onError = error => finish({ ok: false, error: error?.message || String(error) });
    const onClose = code => finish({ ok: code === 0, code });
    killer.once('error', onError);
    killer.once('close', onClose);
    timer = setTimeout(() => {
      try { killer.kill(); } catch {}
      finish({ ok: false, timeout: true, error: 'taskkill-timeout' });
    }, Math.max(250, Number(timeoutMs) || TASKKILL_TIMEOUT_MS));
  });
}

async function waitForProcessExit(pid, deadline) {
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await delay(100);
  }
  return !processAlive(pid);
}

async function terminateDaemonProcess(pid, timeoutMs = STOP_TIMEOUT_MS) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0 || !processAlive(numeric)) {
    return { exitConfirmed: true, forced: false };
  }
  const deadline = Date.now() + boundedTimeout(timeoutMs, STOP_TIMEOUT_MS, 'stop timeout');

  if (process.platform === 'win32') {
    await runTaskkill(numeric, false, Math.min(TASKKILL_TIMEOUT_MS, Math.max(250, deadline - Date.now())));
    if (await waitForProcessExit(numeric, Math.min(deadline, Date.now() + GRACEFUL_STOP_MS))) {
      return { exitConfirmed: true, forced: false };
    }
    await runTaskkill(numeric, true, Math.min(TASKKILL_TIMEOUT_MS, Math.max(250, deadline - Date.now())));
    return { exitConfirmed: await waitForProcessExit(numeric, deadline), forced: true };
  }

  try { process.kill(numeric, 'SIGTERM'); }
  catch (error) {
    if (error?.code === 'ESRCH') return { exitConfirmed: true, forced: false };
    throw error;
  }
  if (await waitForProcessExit(numeric, Math.min(deadline, Date.now() + GRACEFUL_STOP_MS))) {
    return { exitConfirmed: true, forced: false };
  }

  let forced = true;
  try { process.kill(-numeric, 'SIGKILL'); }
  catch {
    try { process.kill(numeric, 'SIGKILL'); }
    catch (error) {
      if (error?.code !== 'ESRCH') throw error;
      forced = false;
    }
  }
  return { exitConfirmed: await waitForProcessExit(numeric, deadline), forced };
}

async function runtimeStatus(file) {
  const config = readConfig(file);
  const port = Number(config?.server?.port || 8787);
  const health = await healthAt(port, 1000);
  const running = healthMatches(health, config);
  const lock = readLock(file);
  const pid = Number(lock?.pid) || null;
  const alive = pid ? processAlive(pid) : false;
  return {
    running,
    processAlive: alive,
    port,
    health: running ? health.json : null,
    lock,
    cliOwned: alive && cliOwnedLock(lock, file),
    owner: lock?.runtimeOwnerId || null,
    pid
  };
}

function gatewayEntry() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = path.join(root, 'gateway', 'server.bundle.mjs');
  if (fs.statSync(bundle, { throwIfNoEntry: false })?.isFile()) return bundle;
  const source = path.join(root, 'gateway', 'server-entry.mjs');
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`DevMate Gateway entry is missing: ${source}`);
  return source;
}

export async function daemonStatus(options = {}) {
  const file = configFile(options);
  if (!fs.existsSync(file)) return { ok: false, running: false, config: file, reason: 'config-not-found' };
  const status = await runtimeStatus(file);
  return { ok: true, config: file, ...status };
}

export async function startDaemon(options = {}) {
  const file = configFile(options);
  if (!fs.existsSync(file)) throw new Error(`Config not found: ${file}`);
  const config = readConfig(file);
  const separation = standaloneStateSeparation(file, configuredWorkspaceRoots(config));
  if (!separation.ok) throw new Error(`Standalone state overlaps a controlled workspace: ${separation.reason}`);
  const timeoutMs = boundedTimeout(options.timeout, START_TIMEOUT_MS, '--timeout');

  let current = await runtimeStatus(file);
  if (current.running) {
    return {
      ok: true,
      started: false,
      attached: true,
      config: file,
      port: current.port,
      owner: current.owner,
      cliOwned: current.cliOwned
    };
  }
  if (current.processAlive && !current.cliOwned) {
    throw new Error(`A Gateway owner process exists but is not healthy: ${current.owner || 'unknown'}`);
  }
  if (current.cliOwned) {
    const deadline = Date.now() + timeoutMs;
    const existingPid = current.pid;
    while (Date.now() < deadline && processAlive(existingPid)) {
      current = await runtimeStatus(file);
      if (current.running) {
        return { ok: true, started: false, attached: true, config: file, port: current.port, owner: current.owner, cliOwned: true, pid: current.pid };
      }
      await delay(200);
    }
    if (processAlive(existingPid)) throw new Error(`Existing CLI-owned Gateway ${existingPid} did not become ready`);
  }

  const files = runtimeFiles(file);
  fs.mkdirSync(files.stateRoot, { recursive: true, mode: 0o700 });
  let logFd = null;
  let child = null;
  try {
    logFd = fs.openSync(files.log, 'a', 0o600);
    const ownerId = `${CLI_OWNER_PREFIX}${process.pid}-${Date.now().toString(36)}`;
    child = spawn(process.execPath, [gatewayEntry()], {
      cwd: path.resolve(path.dirname(file)),
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        DEVMATE_CONFIG: file,
        DEVMATE_PUBLIC_HEALTH_DETAILS: '0',
        DEVMATE_RUNTIME_OWNER_ID: ownerId,
        DEVMATE_RUNTIME_PARENT_PID: String(process.pid),
        DEVMATE_RUNTIME_LAUNCH_MODE: 'standalone-cli-daemon'
      },
      stdio: ['ignore', logFd, logFd]
    });
    child.unref();
    fs.closeSync(logFd);
    logFd = null;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await runtimeStatus(file);
      if (status.running) {
        if (status.owner !== ownerId) {
          if (processAlive(child.pid)) await terminateDaemonProcess(child.pid, STOP_TIMEOUT_MS);
          return { ok: true, started: false, attached: true, config: file, port: status.port, owner: status.owner, cliOwned: status.cliOwned, pid: status.pid };
        }
        return { ok: true, started: true, attached: false, config: file, port: status.port, owner: status.owner, pid: status.pid, log: files.log };
      }
      if (!processAlive(child.pid)) break;
      await delay(250);
    }
    if (processAlive(child.pid)) await terminateDaemonProcess(child.pid, STOP_TIMEOUT_MS);
    throw new Error(`DevMate Gateway did not become ready. See ${files.log}`);
  } finally {
    if (logFd != null) {
      try { fs.closeSync(logFd); } catch {}
    }
  }
}

export async function stopDaemon(options = {}) {
  const file = configFile(options);
  if (!fs.existsSync(file)) return { ok: true, stopped: false, config: file, reason: 'config-not-found' };
  const current = await runtimeStatus(file);
  if (current.processAlive && !current.cliOwned) {
    const error = new Error(`Refusing to stop Gateway owned by another host: ${current.owner || 'unknown'}`);
    error.code = 'standalone_daemon_foreign_owner';
    throw error;
  }
  if (!current.running && !current.cliOwned) return { ok: true, stopped: false, config: file, reason: 'not-running' };
  if (!current.cliOwned) {
    const error = new Error(`Refusing to stop Gateway owned by another host: ${current.owner || 'unknown'}`);
    error.code = 'standalone_daemon_foreign_owner';
    throw error;
  }

  const timeoutMs = boundedTimeout(options.timeout, STOP_TIMEOUT_MS, '--timeout');
  const terminated = await terminateDaemonProcess(current.pid, timeoutMs);
  if (!terminated.exitConfirmed) throw new Error(`Timed out waiting for DevMate Gateway ${current.pid} to exit`);

  const after = await runtimeStatus(file);
  if (after.running) {
    return {
      ok: true,
      stopped: true,
      attached: true,
      config: file,
      previousPid: current.pid,
      owner: after.owner,
      pid: after.pid
    };
  }
  return { ok: true, stopped: true, forced: terminated.forced, config: file, pid: current.pid };
}

export async function restartDaemon(options = {}) {
  const file = configFile(options);
  const current = fs.existsSync(file) ? await runtimeStatus(file) : null;
  if (current?.processAlive && !current.cliOwned) {
    const error = new Error(`Refusing to restart Gateway owned by another host: ${current.owner || 'unknown'}`);
    error.code = 'standalone_daemon_foreign_owner';
    throw error;
  }
  if (current?.running && !current.cliOwned) {
    const error = new Error(`Refusing to restart Gateway owned by another host: ${current.owner || 'unknown'}`);
    error.code = 'standalone_daemon_foreign_owner';
    throw error;
  }
  const stopped = await stopDaemon(options);
  const started = await startDaemon(options);
  return { ok: true, stopped, started };
}

export const __test = {
  CLI_OWNER_PREFIX,
  boundedTimeout,
  cliOwnedLock,
  configuredWorkspaceRoots,
  processAlive,
  readLock,
  runTaskkill,
  runtimeFiles,
  terminateDaemonProcess,
  waitForProcessExit
};
