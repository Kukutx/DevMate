'use strict';

const { spawn } = require('node:child_process');
const { terminateProcessTree } = require('./process-tree.js');

const START_MESSAGE_TIMEOUT_MS = 10000;
const CLEANUP_RETRY_MS = 2000;
const CLEANUP_OPTIONS = Object.freeze({
  gracefulWaitMs: 1500,
  forceWaitMs: 1500,
  finalWaitMs: 500,
  taskkillTimeoutMs: 1000
});

let provider = null;
let started = false;
let shuttingDown = false;
let shutdownPromise = null;

function fail(message) {
  try { process.stderr.write(`DevMate provider supervisor: ${message}\n`); } catch {}
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ms) || CLEANUP_RETRY_MS)));
}

function cleanOptions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const options = {
    windowsHide: source.windowsHide !== false,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  };
  if (source.cwd) options.cwd = String(source.cwd);
  if (source.env && typeof source.env === 'object' && !Array.isArray(source.env)) {
    options.env = Object.fromEntries(Object.entries(source.env).map(([key, item]) => [String(key), String(item)]));
  }
  return options;
}

function validateStartMessage(message) {
  if (!message || message.type !== 'devmate:provider-start') throw new Error('Invalid provider supervisor start message');
  const command = String(message.command || '').trim();
  if (!command) throw new Error('Provider command is required');
  if (!Array.isArray(message.args) || message.args.some(item => typeof item !== 'string') || message.args.length > 128) {
    throw new TypeError('Provider args must be a bounded array of strings');
  }
  return { command, args: [...message.args], options: cleanOptions(message.options) };
}

function relay(stream, target) {
  if (!stream || !target) return;
  stream.on('data', chunk => {
    try { target.write(chunk); } catch {}
  });
}

function childActive(child) {
  return !!child && child.exitCode == null && child.signalCode == null;
}

async function shutdown(reason = 'shutdown', requestedExitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    let exitCode = requestedExitCode;
    const child = provider;
    let attempts = 0;

    // The supervisor is the ownership fence for the real provider process.
    // Never exit the fence while provider-tree termination is unconfirmed;
    // retry until the provider is known dead. The parent may time out and keep
    // the shared ownership record rather than falsely declaring cleanup done.
    while (childActive(child)) {
      attempts += 1;
      let confirmed = false;
      try {
        const result = await terminateProcessTree(child, CLEANUP_OPTIONS);
        confirmed = result?.exitConfirmed !== false;
        if (!confirmed) fail(`could not confirm provider process exit during ${reason} (attempt ${attempts})`);
      } catch (error) {
        fail(`provider cleanup failed during ${reason} (attempt ${attempts}): ${error?.message || error}`);
      }
      if (confirmed || !childActive(child)) break;
      await delay(CLEANUP_RETRY_MS);
    }

    provider = null;
    try {
      if (process.connected) process.send?.({
        type: 'devmate:provider-supervisor-stopped',
        reason,
        exitCode,
        exitConfirmed: true,
        cleanupAttempts: attempts
      });
    } catch {}
    process.exitCode = exitCode;
    setImmediate(() => process.exit(exitCode));
    return { reason, exitCode, exitConfirmed: true, cleanupAttempts: attempts };
  })();
  return shutdownPromise;
}

function launch(message) {
  if (started || shuttingDown) return;
  const { command, args, options } = validateStartMessage(message);
  started = true;
  provider = spawn(command, args, options);
  relay(provider.stdout, process.stdout);
  relay(provider.stderr, process.stderr);
  provider.once('error', error => {
    fail(`provider launch error: ${error.message || error}`);
    if (!shuttingDown) void shutdown('provider-error', 1);
  });
  provider.once('close', (code, signal) => {
    if (shuttingDown) return;
    provider = null;
    try {
      if (process.connected) process.send?.({
        type: 'devmate:provider-exit',
        code: code ?? null,
        signal: signal || null
      });
    } catch {}
    const exitCode = Number.isInteger(code) ? code : 1;
    setImmediate(() => process.exit(exitCode));
  });
  try {
    if (process.connected) process.send?.({ type: 'devmate:provider-started', pid: provider.pid || null });
  } catch {}
}

const startTimer = setTimeout(() => {
  if (!started) void shutdown('start-message-timeout', 1);
}, START_MESSAGE_TIMEOUT_MS);
startTimer.unref?.();

process.on('message', message => {
  if (message?.type === 'devmate:provider-stop') {
    void shutdown('parent-stop', 0);
    return;
  }
  try {
    launch(message);
    if (started) clearTimeout(startTimer);
  } catch (error) {
    fail(`rejected launch: ${error.message || error}`);
    void shutdown('invalid-start-message', 1);
  }
});

process.once('disconnect', () => { void shutdown('parent-disconnect', 0); });
process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });
