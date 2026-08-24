import { spawn } from 'node:child_process';
import { terminateProcessTree } from './command-process.mjs';

const EXECUTABLE_KEY = 'DEVMATE_CODEX_SUPERVISOR_EXECUTABLE';
const ARGS_KEY = 'DEVMATE_CODEX_SUPERVISOR_ARGS';
const CLEANUP_RETRY_MS = 2000;
const CLEANUP = Object.freeze({ graceMs: 1500, forceMs: 2500 });

let child = null;
let shuttingDown = false;
let shutdownPromise = null;

function fail(message) {
  try { process.stderr.write(`DevMate Codex supervisor: ${message}\n`); } catch {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ms) || CLEANUP_RETRY_MS)));
}

function childActive(value) {
  return !!value && value.exitCode == null && value.signalCode == null;
}

function launchSpec() {
  const executable = String(process.env[EXECUTABLE_KEY] || '').trim();
  if (!executable) throw new Error('Codex supervisor executable is missing');
  let args;
  try { args = JSON.parse(String(process.env[ARGS_KEY] || '[]')); }
  catch { throw new Error('Codex supervisor args are invalid JSON'); }
  if (!Array.isArray(args) || args.some(value => typeof value !== 'string') || args.length > 20) {
    throw new Error('Codex supervisor args must be a bounded string array');
  }
  return { executable, args };
}

function childEnvironment() {
  const env = { ...process.env };
  delete env[EXECUTABLE_KEY];
  delete env[ARGS_KEY];
  return env;
}

async function shutdown(reason = 'shutdown', requestedExitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const current = child;
    let attempts = 0;
    if (current) {
      try { process.stdin.unpipe(current.stdin); } catch {}
      try { current.stdin?.end(); } catch {}
    }

    // This supervisor is the lifetime fence for the detached Codex app-server.
    // Do not exit the fence while process-tree termination remains ambiguous.
    // The Gateway may time out waiting for us, but it must keep this supervisor
    // alive rather than orphaning an unconfirmed delegated process.
    while (childActive(current)) {
      attempts += 1;
      let confirmed = false;
      try {
        const result = await terminateProcessTree(current, CLEANUP);
        confirmed = result.exitConfirmed !== false;
        if (!confirmed) fail(`could not confirm Codex process exit during ${reason} (attempt ${attempts})`);
      } catch (error) {
        fail(`Codex cleanup failed during ${reason} (attempt ${attempts}): ${error?.message || error}`);
      }
      if (confirmed || !childActive(current)) break;
      await delay(CLEANUP_RETRY_MS);
    }

    if (child === current) child = null;
    try {
      if (process.connected) process.send?.({
        type: 'devmate:codex-supervisor-stopped',
        reason,
        exitCode: requestedExitCode,
        exitConfirmed: true,
        cleanupAttempts: attempts
      });
    } catch {}
    process.exitCode = requestedExitCode;
    setImmediate(() => process.exit(requestedExitCode));
    return { reason, exitCode: requestedExitCode, exitConfirmed: true, cleanupAttempts: attempts };
  })();
  return shutdownPromise;
}

function launch() {
  const { executable, args } = launchSpec();
  child = spawn(executable, args, {
    cwd: process.cwd(),
    env: childEnvironment(),
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once('error', error => {
    fail(`Codex launch failed: ${error?.message || error}`);
    void shutdown('codex-error', 1);
  });
  child.once('close', (code, signal) => {
    if (shuttingDown) return;
    child = null;
    try {
      if (process.connected) process.send?.({
        type: 'devmate:codex-exit',
        code: code ?? null,
        signal: signal || null
      });
    } catch {}
    const exitCode = Number.isInteger(code) ? code : 1;
    setImmediate(() => process.exit(exitCode));
  });
  try {
    if (process.connected) process.send?.({ type: 'devmate:codex-started', pid: child.pid || null });
  } catch {}
}

process.on('message', message => {
  if (message?.type === 'devmate:codex-stop') void shutdown('parent-stop', 0);
});
process.once('disconnect', () => { void shutdown('parent-disconnect', 0); });
process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });

try { launch(); }
catch (error) {
  fail(error?.message || error);
  void shutdown('launch-invalid', 1);
}