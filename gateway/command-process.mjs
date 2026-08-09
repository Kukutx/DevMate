import { spawn } from 'node:child_process';
import { requestSignal } from './request-context.mjs';

const activeProcesses = new Set();

function waitForExit(child) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve({ code: child.exitCode ?? null, signal: child.signalCode || null });
  return new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal: signal || null }));
    child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
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

async function runTaskkill(pid) {
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  });
  await waitForExit(killer);
}

export async function terminateProcessTree(child, { graceMs = 1500, forceMs = 2500 } = {}) {
  if (!child || child.exitCode != null || child.signalCode != null) return { terminated: false, forced: false, exitConfirmed: true };

  if (process.platform === 'win32') {
    await runTaskkill(child.pid);
    const exit = await waitWithTimeout(waitForExit(child), forceMs);
    return { terminated: true, forced: true, exitConfirmed: !!exit };
  }

  try { process.kill(-child.pid, 'SIGTERM'); }
  catch (error) {
    if (error.code === 'ESRCH') return { terminated: false, forced: false, exitConfirmed: true };
    throw error;
  }
  let exit = await waitWithTimeout(waitForExit(child), graceMs);
  if (exit) return { terminated: true, forced: false, exitConfirmed: true };

  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  exit = await waitWithTimeout(waitForExit(child), forceMs);
  return { terminated: true, forced: true, exitConfirmed: !!exit };
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
    env: environment || process.env,
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
    if (!termination.exitConfirmed && !exit) exit = await exitPromise;
  }

  activeProcesses.delete(child);
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
