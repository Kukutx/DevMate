import { spawn } from 'node:child_process';
import { terminateProcessTree } from './command-process.mjs';

const EXECUTABLE_KEY = 'DEVMATE_CODEX_SUPERVISOR_EXECUTABLE';
const ARGS_KEY = 'DEVMATE_CODEX_SUPERVISOR_ARGS';
const CLEANUP = Object.freeze({ graceMs: 1500, forceMs: 2500 });

let child = null;
let shuttingDown = false;
let shutdownPromise = null;

function fail(message) {
  try { process.stderr.write(`DevMate Codex supervisor: ${message}\n`); } catch {}
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
    let exitCode = requestedExitCode;
    const current = child;
    child = null;
    if (current && current.exitCode == null && current.signalCode == null) {
      try {
        process.stdin.unpipe(current.stdin);
        try { current.stdin?.end(); } catch {}
        const result = await terminateProcessTree(current, CLEANUP);
        if (result.exitConfirmed === false) {
          exitCode = 1;
          fail(`could not confirm Codex process exit during ${reason}`);
        }
      } catch (error) {
        exitCode = 1;
        fail(`Codex cleanup failed during ${reason}: ${error?.message || error}`);
      }
    }
    try {
      if (process.connected) process.send?.({ type: 'devmate:codex-supervisor-stopped', reason, exitCode });
    } catch {}
    process.exitCode = exitCode;
    setImmediate(() => process.exit(exitCode));
    return { reason, exitCode };
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
