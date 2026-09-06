import { spawn } from 'node:child_process';
import processTreeRuntime from '../host/runtime/process-tree.js';
import { requestSignal } from './request-context.mjs';

const { runTaskkill: runBoundedTaskkill } = processTreeRuntime;
const activeProcesses = new Set();

function isGitCommand(command) {
  const text = String(command || '').trim();
  if (/(?:^|[\\/])git(?:\.exe)?$/i.test(text)) return true;
  return /^(?:git(?:\.exe)?|"[^"\r\n]*[\\/]git(?:\.exe)?"|'[^'\r\n]*[\\/]git(?:\.exe)?')(?:\s|$)/i.test(text);
}

export function commandEnvironment(command, environment = null, forceGitNonInteractive = false) {
  const env = { ...(environment || process.env) };
  if (forceGitNonInteractive || isGitCommand(command)) {
    env.GIT_TERMINAL_PROMPT = '0';
    env.GCM_INTERACTIVE = 'Never';
  }
  return env;
}

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve({ code: child.exitCode ?? null, signal: child.signalCode || null });
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      child.off?.('close', onClose);
      child.off?.('error', onError);
      resolve(value);
    };
    const onClose = (code, signal) => finish({ code, signal: signal || null });
    const onError = error => finish({ code: null, signal: null, error: error.message });
    child.once('close', onClose);
    child.once('error', onError);
  });
}

function waitWithTimeout(promise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function processGroupAlive(pid, killImpl = process.kill) {
  const groupId = Number(pid || 0);
  if (!Number.isInteger(groupId) || groupId <= 0) return false;
  try {
    killImpl(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs, killImpl = process.kill) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (processGroupAlive(pid, killImpl)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

function appendBounded(current, chunk, limit) {
  const value = current + String(chunk || '');
  return value.length <= limit ? value : value.slice(-limit);
}

function cancellationError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : 'Command cancelled');
  error.code = 'request_cancelled';
  return error;
}

function ipcCleanupSupervisor(child) {
  return !!child && typeof child.send === 'function' && child.channel != null;
}

export async function terminateProcessTree(child, { graceMs = 1500, forceMs = 2500 } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return { terminated: false, forced: false, exitConfirmed: true };

  // IPC children are cleanup supervisors (currently the Codex supervisor).
  // Their parent sends the explicit stop protocol before calling this helper.
  // Never taskkill/SIGKILL the supervisor merely because its own process tree
  // has not yet reached a confirmed terminal state: that would destroy the
  // ownership fence while the real delegated process could still be alive.
  if (ipcCleanupSupervisor(child)) {
    const exit = await waitWithTimeout(waitForExit(child), Math.max(1000, Number(graceMs) || 1500) + Math.max(1000, Number(forceMs) || 2500));
    return { terminated: true, forced: false, exitConfirmed: !!exit, supervisorCleanupPending: !exit };
  }

  if (process.platform === 'win32') {
    await runBoundedTaskkill(child.pid, true, spawn, Math.max(1000, forceMs));
    const exit = await waitWithTimeout(waitForExit(child), forceMs);
    return { terminated: true, forced: true, exitConfirmed: !!exit };
  }

  const pid = Number(child.pid || 0);
  const exitPromise = waitForExit(child);
  const graceDeadline = Date.now() + Math.max(0, Number(graceMs) || 0);
  try { process.kill(-pid, 'SIGTERM'); }
  catch (error) {
    if (error.code === 'ESRCH') {
      const exit = await waitWithTimeout(exitPromise, 100);
      return { terminated: false, forced: false, exitConfirmed: !!exit };
    }
    throw error;
  }
  let exit = await waitWithTimeout(exitPromise, graceMs);
  let groupExited = await waitForProcessGroupExit(pid, Math.max(0, graceDeadline - Date.now()));
  if (exit && groupExited) return { terminated: true, forced: false, exitConfirmed: true };

  const forceDeadline = Date.now() + Math.max(0, Number(forceMs) || 0);
  try { process.kill(-pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  exit ||= await waitWithTimeout(exitPromise, forceMs);
  groupExited = await waitForProcessGroupExit(pid, Math.max(0, forceDeadline - Date.now()));
  if (!exit && groupExited) exit = await waitWithTimeout(exitPromise, 100);
  return { terminated: true, forced: true, exitConfirmed: !!exit && groupExited };
}

export async function executeCommand(command, args = [], {
  cwd,
  timeoutMs = 180000,
  maxOutputChars = 120000,
  shell = false,
  environment,
  signal = requestSignal()
} = {}) {
  if (signal?.aborted) throw cancellationError(signal);
  const child = spawn(command, args, {
    cwd,
    env: commandEnvironment(command, environment, shell),
    shell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeProcesses.add(child);

  const captureLimit = Math.max(maxOutputChars * 2, maxOutputChars);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk, captureLimit); });
  child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk, captureLimit); });

  const exitPromise = waitForExit(child);
  void exitPromise.then(() => activeProcesses.delete(child));
  const winner = await new Promise(resolve => {
    let settled = false;
    let abortListener = null;
    const timer = setTimeout(() => finish({ type: 'timeout' }), timeoutMs);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortListener && signal) signal.removeEventListener('abort', abortListener);
      resolve(value);
    };
    if (signal) {
      abortListener = () => finish({ type: 'aborted', error: cancellationError(signal) });
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) abortListener();
    }
    exitPromise.then(exit => finish({ type: 'exit', exit }));
  });

  let exit = winner.exit || null;
  let termination = { terminated: false, forced: false, exitConfirmed: true };
  if (winner.type === 'timeout' || winner.type === 'aborted') {
    termination = await terminateProcessTree(child);
    exit = await waitWithTimeout(exitPromise, 100);
    if (exit && !termination.exitConfirmed) termination = { ...termination, exitConfirmed: true };
  }

  if (exit || child.exitCode != null || child.signalCode != null) activeProcesses.delete(child);
  if (winner.type === 'aborted') throw winner.error;
  return {
    command: shell ? String(command) : [command, ...args].join(' '),
    cwd,
    exitCode: exit?.code ?? child.exitCode ?? null,
    signal: exit?.signal || child.signalCode || null,
    error: exit?.error,
    timedOut: winner.type === 'timeout',
    ...termination,
    stdout: stdout.slice(-maxOutputChars),
    stderr: stderr.slice(-maxOutputChars),
    stdoutTruncated: stdout.length > maxOutputChars,
    stderrTruncated: stderr.length > maxOutputChars
  };
}

export async function shutdownCommandProcesses() {
  const results = [];
  for (const child of [...activeProcesses]) {
    results.push(await terminateProcessTree(child));
    if (child.exitCode != null || child.signalCode != null) activeProcesses.delete(child);
  }
  return results;
}

export function activeCommandProcessCount() {
  return activeProcesses.size;
}

export const __test = { ipcCleanupSupervisor, processGroupAlive, waitForExit, waitForProcessGroupExit, waitWithTimeout };
