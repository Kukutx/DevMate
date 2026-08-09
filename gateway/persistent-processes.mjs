import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  assertCanMutate, assertCommandAllowed, audit, getWritableWorkspace, normalizeSlash, now,
  processLimits, readConfig, redactSensitiveString, resolveWorkspaceCwd, syncTrustedRootsIntoConfig
} from './local-shared.mjs';

const PROCESS_RETENTION_MS = 60 * 60 * 1000;
const PROCESS_REGISTRY_LIMIT = 100;
export const DEFAULT_READ_CHARS = 120000;
export const MAX_READ_CHARS = 500000;
const registry = new Map();
let nextNumber = 1;

function processOwned(record) {
  return record?.status === 'running' || record?.status === 'stopping';
}

export function runningProcesses() {
  return [...registry.values()].filter(processOwned);
}
export function pruneProcessRegistry() {
  const cutoff = Date.now() - PROCESS_RETENTION_MS;
  for (const [id, record] of registry) {
    if (!processOwned(record) && Date.parse(record.finishedAt || 0) < cutoff) registry.delete(id);
  }
  if (registry.size <= PROCESS_REGISTRY_LIMIT) return;
  const finished = [...registry.values()]
    .filter(record => !processOwned(record))
    .sort((a, b) => Date.parse(a.finishedAt || 0) - Date.parse(b.finishedAt || 0));
  while (registry.size > PROCESS_REGISTRY_LIMIT && finished.length) registry.delete(finished.shift().id);
}
export function appendOutput(record, stream, chunk) {
  const text = String(chunk ?? '');
  if (!text) return;
  for (let offset = 0; offset < text.length; offset += 4096) {
    const piece = text.slice(offset, offset + 4096);
    record.sequence += 1;
    record.events.push({ sequence: record.sequence, stream, time: now(), text: piece });
    record.outputBytes += Buffer.byteLength(piece, 'utf8');
  }
  while (record.outputBytes > record.outputLimitBytes && record.events.length > 1) {
    const removed = record.events.shift();
    record.outputBytes -= Buffer.byteLength(removed.text, 'utf8');
    record.firstSequence = removed.sequence + 1;
  }
}
export function processPublic(record) {
  return {
    id: record.id, label: record.label, workspaceId: record.workspaceId, workspaceName: record.workspaceName,
    cwd: record.cwd, command: redactSensitiveString(record.command), pid: record.child?.pid || record.pid || null,
    status: record.status, startedAt: record.startedAt, finishedAt: record.finishedAt || null,
    exitCode: record.exitCode ?? null, signal: record.signal || null, error: record.error || null,
    firstSequence: record.firstSequence, lastSequence: record.sequence,
    outputBytes: record.outputBytes, outputLimitBytes: record.outputLimitBytes
  };
}
export function processRecord(id) {
  const record = registry.get(id);
  if (!record) throw new Error(`Persistent process not found: ${id}`);
  return record;
}
function waitForExit(record, timeoutMs) {
  if (!processOwned(record)) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
    const onExit = () => { cleanup(); resolve(true); };
    const cleanup = () => { clearTimeout(timer); record.child?.off('close', onExit); };
    record.child?.once('close', onExit);
  });
}
export async function killProcessTree(record, force = false, {
  gracefulWaitMs = 3000,
  forceWaitMs = 4000,
  finalWaitMs = 1500
} = {}) {
  if (!record.child || !processOwned(record)) return true;
  record.status = 'stopping';
  const pid = record.child.pid;
  if (process.platform === 'win32' && pid) {
    await new Promise(resolve => {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      killer.once('error', done);
      killer.once('close', done);
    });
  } else if (pid) {
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { try { record.child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {} }
  } else {
    try { record.child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
  }

  if (await waitForExit(record, force ? forceWaitMs : gracefulWaitMs)) return true;
  if (!force) return killProcessTree(record, true, { gracefulWaitMs, forceWaitMs, finalWaitMs });

  try { record.child.kill('SIGKILL'); } catch {}
  if (await waitForExit(record, finalWaitMs)) return true;

  record.status = 'stopping';
  record.error = 'Process tree termination could not be confirmed';
  appendOutput(record, 'system', 'Process tree termination was requested but exit could not be confirmed; ownership is retained.\n');
  return false;
}
export async function shutdownPersistentProcesses() {
  await Promise.allSettled(runningProcesses().map(record => killProcessTree(record, true)));
}
export async function startPersistentProcess({ workspaceId, command, cwd = '.', label = '', environment = {}, autoStopAfterMs }) {
  const config = syncTrustedRootsIntoConfig();
  assertCommandAllowed(config, command);
  const workspace = getWritableWorkspace(config, workspaceId);
  const directory = resolveWorkspaceCwd(workspace, cwd);
  pruneProcessRegistry();
  const limits = processLimits(config);
  if (runningProcesses().length >= limits.maxProcesses) {
    throw new Error(`Persistent process limit reached (${limits.maxProcesses}). Stop a process before starting another.`);
  }
  const id = `proc-${Date.now().toString(36)}-${nextNumber++}-${crypto.randomBytes(2).toString('hex')}`;
  const child = spawn(command, [], {
    cwd: directory, shell: true, windowsHide: true, detached: process.platform !== 'win32',
    env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const record = {
    id, label: String(label || '').trim() || command.slice(0, 80), command, cwd: directory,
    workspaceId: workspace.id, workspaceName: workspace.name, child, pid: child.pid || null,
    status: 'running', startedAt: now(), finishedAt: null, exitCode: null, signal: null, error: null,
    sequence: 0, firstSequence: 1, events: [], outputBytes: 0,
    outputLimitBytes: limits.outputBytes, autoStopTimer: null
  };
  registry.set(id, record);
  child.stdout?.on('data', chunk => appendOutput(record, 'stdout', chunk));
  child.stderr?.on('data', chunk => appendOutput(record, 'stderr', chunk));
  child.on('error', error => {
    record.error = error.message;
    if (!record.child?.pid) { record.status = 'failed'; record.finishedAt = now(); }
    appendOutput(record, 'system', `Process error: ${error.message}\n`);
  });
  child.on('close', (code, signal) => {
    if (record.autoStopTimer) clearTimeout(record.autoStopTimer);
    record.status = 'exited'; record.exitCode = code; record.signal = signal || null; record.finishedAt = now();
    appendOutput(record, 'system', `Process exited with code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}.\n`);
    pruneProcessRegistry();
  });
  if (autoStopAfterMs) record.autoStopTimer = setTimeout(() => { void killProcessTree(record, false); }, autoStopAfterMs);
  await audit('start_process', {
    processId: id, workspace: workspace.id, command,
    cwd: normalizeSlash(path.relative(workspace.root, directory)), pid: child.pid || null
  });
  return processPublic(record);
}
export function listPersistentProcesses(includeFinished = true) {
  pruneProcessRegistry();
  return [...registry.values()]
    .filter(record => includeFinished || processOwned(record))
    .map(processPublic);
}
export function readPersistentOutput(id, afterSequence = 0, maxChars = DEFAULT_READ_CHARS) {
  const record = processRecord(id);
  const missed = afterSequence < record.firstSequence - 1;
  const events = [];
  let chars = 0;
  for (const event of record.events) {
    if (event.sequence <= afterSequence) continue;
    if (chars + event.text.length > maxChars) break;
    events.push(event);
    chars += event.text.length;
  }
  return {
    process: processPublic(record), afterSequence, firstAvailableSequence: record.firstSequence,
    nextSequence: events.length ? events[events.length - 1].sequence : afterSequence, missed, events
  };
}
export async function sendPersistentInput(id, input, appendNewline = true) {
  const config = readConfig();
  assertCanMutate(config, 'Persistent process input');
  const record = processRecord(id);
  if (record.status !== 'running' || !record.child?.stdin?.writable) throw new Error(`Process is not accepting input: ${id}`);
  await new Promise((resolve, reject) => record.child.stdin.write(
    `${input}${appendNewline ? '\n' : ''}`, error => error ? reject(error) : resolve()
  ));
  await audit('send_process_input', { processId: id, chars: input.length, appendNewline });
  return processPublic(record);
}
export async function stopPersistentProcess(id, force = false, forget = false, terminationOptions = {}) {
  const config = readConfig();
  assertCanMutate(config, 'Stopping a persistent process');
  const record = processRecord(id);
  const exitConfirmed = await killProcessTree(record, force, terminationOptions);
  const stopped = exitConfirmed && !processOwned(record);
  if (forget && stopped) registry.delete(id);
  await audit('stop_process', { processId: id, force, forget, stopped, exitConfirmed });
  return {
    stopped,
    exitConfirmed,
    forgotten: !registry.has(id), process: registry.has(id) ? processPublic(record) : null
  };
}
export const __test = { processOwned, registry };
