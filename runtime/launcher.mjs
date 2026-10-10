import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import processTree from './platform/process-tree.js';
import {
  createRuntimeClient, DEFAULT_RUNTIME_PORT, instanceFiles, matchesRuntime, readRuntimeRecord
} from './client.mjs';
import { probeInstanceLock } from './instance-lock.mjs';
import userPath from './platform/user-path.cjs';

const { childExited, terminateProcessTree } = processTree;
const { completePath } = userPath;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

function timeout(value, fallback = 20000) {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 100 || result > 120000) throw new Error('Timeout must be 100..120000 milliseconds');
  return result;
}

function runtimePort(value) {
  const port = value === undefined ? DEFAULT_RUNTIME_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  return port;
}

/** The newest part of the runtime log, for showing why a start failed. */
export function runtimeLogTail(instanceRoot, { from = 0, bytes = 4000 } = {}) {
  const file = instanceFiles(instanceRoot).log;
  try {
    const size = fs.statSync(file).size, start = Math.max(from, size - bytes), length = size - start;
    if (length <= 0) return '';
    const fd = fs.openSync(file, 'r');
    try { const buffer = Buffer.alloc(length); fs.readSync(fd, buffer, 0, length, start); return buffer.toString('utf8').trim(); }
    finally { fs.closeSync(fd); }
  } catch { return ''; }
}
function startFailure(instanceRoot, from) {
  const lines = runtimeLogTail(instanceRoot, { from }).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  for (const line of lines.toReversed()) {
    try { const entry = JSON.parse(line); if (entry.event === 'failed') return { code: entry.code, message: entry.message }; } catch {}
  }
  // A failure while loading the program itself is reported by Node, not by the runtime.
  const thrown = lines.findLast(line => /^[A-Za-z]*Error: /.test(line));
  return thrown ? { message: thrown } : lines.length ? { message: lines.slice(-3).join(' | ') } : null;
}

// Remove the record of a dead runtime, but never one a new runtime published in the meantime.
function discardStaleRecord(files) {
  const read = () => { try { return fs.readFileSync(files.record, 'utf8'); } catch { return null; } };
  const seen = read();
  if (seen !== null && seen === read()) fs.rmSync(files.record, { force: true });
}

/**
 * What is true about this instance right now. The instance lock is the only
 * proof of life: it exists exactly while a runtime process holds it, so a
 * record left behind by a crash never reads as "running" and a recycled
 * process id is never mistaken for a runtime.
 */
export async function runtimeStatus({ instanceRoot, clientFactory = createRuntimeClient, probe = probeInstanceLock } = {}) {
  const files = instanceFiles(instanceRoot);
  const owner = await probe(files.directory);
  // A clean stop removes the record. One that is still there was left by a runtime that died.
  if (!owner.alive) return { state: 'stopped', instanceRoot: files.directory, running: false, ...(fs.existsSync(files.record) ? { crashed: true } : {}) };
  const alive = { instanceRoot: files.directory, running: false, processAlive: true,
    ...(owner.pid ? { owner: { pid: owner.pid, generation: owner.generation } } : {}) };
  if (!owner.responsive) return { ...alive, state: 'unavailable' };
  let record = null;
  try { record = readRuntimeRecord(files.directory); } catch {}
  // The record is published last. Until it names the live owner, that runtime is still starting.
  if (!record || record.generation !== owner.generation) return { ...alive, state: 'starting' };
  let health = null;
  try { health = await clientFactory({ instanceRoot: files.directory }).health({ timeoutMs: 1500 }); } catch {}
  const running = matchesRuntime(health, record);
  return { ...alive, state: running ? 'ready' : health?.status === 'stopping' ? 'stopping' : 'unavailable', running, record, health };
}

export async function startRuntime({
  instanceRoot,
  port,
  timeoutMs,
  nodePath = process.execPath,
  entryPath = fileURLToPath(new URL('./main.mjs', import.meta.url)),
  spawnImpl = spawn,
  clientFactory = createRuntimeClient,
  probe = probeInstanceLock
} = {}) {
  const files = instanceFiles(instanceRoot);
  const selectedPort = runtimePort(port);
  const deadline = Date.now() + timeout(timeoutMs);
  const status = () => runtimeStatus({ instanceRoot: files.directory, clientFactory, probe });
  const remaining = () => Math.min(100, Math.max(1, deadline - Date.now()));
  // Another editor window, the CLI or a previous call may already be running or
  // starting this instance. Join it; never start a second one beside it.
  let current = await status();
  while (current.processAlive && !current.running && Date.now() < deadline) { await pause(remaining()); current = await status(); }
  if (current.running) return { ...current, started: false, attached: true };
  if (current.processAlive) {
    const error = new Error('A DevMate runtime process' + (current.owner ? ' (' + current.owner.pid + ')' : '') + ' holds this instance but is not ready (' + current.state + '). See ' + files.log);
    error.code = 'RUNTIME_ALREADY_RUNNING';
    throw error;
  }
  if (!path.isAbsolute(nodePath) || !fs.statSync(nodePath, { throwIfNoEntry: false })?.isFile()) throw new Error('An existing absolute Node executable is required');
  if (!path.isAbsolute(entryPath) || !fs.statSync(entryPath, { throwIfNoEntry: false })?.isFile()) throw new Error('DevMate runtime entry is missing');
  fs.mkdirSync(files.directory, { recursive: true, mode: 0o700 });
  if ((fs.statSync(files.log, { throwIfNoEntry: false })?.size || 0) > LOG_ROTATE_BYTES) fs.renameSync(files.log, files.log + '.1');
  const logStart = fs.statSync(files.log, { throwIfNoEntry: false })?.size || 0;
  const fd = fs.openSync(files.log, 'a', 0o600);
  let child;
  let launchError;
  try {
    // The runtime outlives the editor window that started it and serves every other entry too:
    // it gets the owner's environment, not the variables an editor injects into its own processes.
    // An entry started from a desktop icon has a minimal PATH; the usual tool directories are added so that
    // commands, package managers and agent CLIs are found whichever entry happened to start the runtime.
    const environment = completePath(Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ELECTRON_|VSCODE_)/i.test(name))));
    child = spawnImpl(nodePath, [entryPath, '--instance', files.directory, '--port', String(selectedPort)], {
      cwd: files.directory, detached: true, windowsHide: true, shell: false,
      env: environment, stdio: ['ignore', fd, fd]
    });
    child.once('error', error => { launchError = error; });
  } finally {
    fs.closeSync(fd);
  }
  try {
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      current = await status();
      if (current.running) {
        // When two starters raced, the loser's process has already left on its own: the lock refused it.
        child.unref();
        return { ...current, started: current.record.pid === child.pid, attached: current.record.pid !== child.pid };
      }
      if (childExited(child) && !current.processAlive) {
        const reason = startFailure(files.directory, logStart);
        const error = new Error('DevMate runtime exited before readiness' + (reason ? ': ' + reason.message.replace(/\.\s*$/, '') : '') + '. See ' + files.log);
        if (reason?.code) error.code = reason.code;
        throw error;
      }
      await pause(remaining());
    }
    throw new Error(`DevMate runtime startup timed out. See ${files.log}`);
  } catch (error) {
    if (child && !childExited(child)) await terminateProcessTree(child);
    throw error;
  }
}

export async function stopRuntime({
  instanceRoot, timeoutMs, clientFactory = createRuntimeClient, probe = probeInstanceLock
} = {}) {
  const files = instanceFiles(instanceRoot);
  const duration = timeout(timeoutMs);
  const current = await runtimeStatus({ instanceRoot: files.directory, clientFactory, probe });
  if (!current.processAlive) {
    // An explicit stop also settles a crash: nothing is left that asks a host to start the runtime again.
    if (current.crashed) discardStaleRecord(files);
    return { stopped: true, alreadyStopped: true, instanceRoot: files.directory };
  }
  const stoppable = current.record && ['ready', 'stopping', 'shutdown_failed'].includes(current.health?.status) &&
    matchesRuntime({ ...current.health, status: 'ready' }, current.record);
  if (!stoppable) throw new Error('The runtime process' + (current.owner ? ' (' + current.owner.pid + ')' : '') + ' is ' + current.state + ' and does not answer as this instance; nothing was stopped');
  const expectedGeneration = current.record.generation;
  await clientFactory({ instanceRoot: files.directory }).call('runtime.stop', { expectedGeneration }, { timeoutMs: duration });
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    const owner = await probe(files.directory);
    if (!owner.alive) return { stopped: true, instanceRoot: files.directory, generation: expectedGeneration };
    if (owner.generation && owner.generation !== expectedGeneration) throw new Error('Runtime generation changed while stopping');
    await pause(100);
  }
  throw new Error('Runtime stop is still pending: it is waiting for its own processes to end. Nothing was killed; run stop again or see ' + files.log);
}
