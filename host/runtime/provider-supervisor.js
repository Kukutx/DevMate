'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { terminateProcessTree } = require('./process-tree.js');
const { readLifecycleIntent } = require('../../shared/lifecycle-intent.cjs');
const { SharedTunnelRecordStore } = require('../../vscode-host/shared-tunnel-record-store.js');

const START_MESSAGE_TIMEOUT_MS = 10000;
const CLEANUP_RETRY_MS = 2000;
const MANAGED_WATCH_MS = 2000;
const MANAGED_CONFIG_FAILURE_GRACE_MS = 5000;
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
let control = null;
let store = null;
let managedWatch = null;
let managedFailureSince = 0;

function fail(message) {
  try { process.stderr.write(`DevMate provider supervisor: ${message}\n`); } catch {}
}

function ignoreBrokenPipe(stream) {
  stream?.on?.('error', error => {
    if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') return;
  });
}

ignoreBrokenPipe(process.stdout);
ignoreBrokenPipe(process.stderr);

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

function cleanControl(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid provider supervisor control metadata');
  const stateDirectory = path.resolve(String(value.stateDirectory || '').trim());
  const ownerId = String(value.ownerId || '').trim();
  const hostId = String(value.hostId || '').trim();
  const providerName = String(value.provider || '').trim().toLowerCase();
  const configurationKey = String(value.configurationKey || '').trim().toLowerCase();
  const port = Number(value.port);
  const leaseMs = Number(value.leaseMs);
  if (!String(value.stateDirectory || '').trim()) throw new Error('Provider supervisor stateDirectory is required');
  if (!ownerId || ownerId.length > 512) throw new Error('Provider supervisor ownerId is invalid');
  if (!hostId || hostId.length > 256) throw new Error('Provider supervisor hostId is invalid');
  if (!['ngrok', 'cloudflare-quick', 'cloudflare-managed'].includes(providerName)) throw new Error(`Unsupported supervised provider: ${providerName}`);
  if (!/^[a-f0-9]{64}$/.test(configurationKey)) throw new Error('Provider supervisor configurationKey is invalid');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Provider supervisor port is invalid');
  if (!Number.isFinite(leaseMs) || leaseMs < 30000 || leaseMs > 24 * 60 * 60 * 1000) throw new Error('Provider supervisor leaseMs is invalid');
  return {
    stateDirectory,
    configFile: path.join(stateDirectory, 'config.json'),
    ownerId,
    hostId,
    provider: providerName,
    configurationKey,
    port,
    leaseMs
  };
}

function validateStartMessage(message) {
  if (!message || message.type !== 'devmate:provider-start') throw new Error('Invalid provider supervisor start message');
  const command = String(message.command || '').trim();
  if (!command) throw new Error('Provider command is required');
  if (!Array.isArray(message.args) || message.args.some(item => typeof item !== 'string') || message.args.length > 128) {
    throw new TypeError('Provider args must be a bounded array of strings');
  }
  return { command, args: [...message.args], options: cleanOptions(message.options), control: cleanControl(message.control) };
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

function writeManagedHeartbeat() {
  if (!control || !store || shuttingDown) return false;
  store.write(control.ownerId, {
    hostId: control.hostId,
    childPid: process.pid,
    childKind: 'supervisor',
    port: control.port,
    provider: control.provider,
    configurationKey: control.configurationKey
  });
  return true;
}

function acknowledgeManagedHandoff() {
  if (!control || !store || shuttingDown) return false;
  writeManagedHeartbeat();
  try {
    if (process.connected) process.send?.({ type: 'devmate:provider-handoff-ready', ownerId: control.ownerId, pid: process.pid });
  } catch {}
  return true;
}

function releaseManagedRecord() {
  if (!control || !store) return false;
  try { writeManagedHeartbeat(); } catch {}
  try { return store.remove(control.ownerId); } catch { return false; }
}

function stopManagedWatch() {
  if (!managedWatch) return;
  clearInterval(managedWatch);
  managedWatch = null;
}

function startManagedWatch() {
  if (!control || !store || managedWatch) return;
  const intervalMs = Math.max(MANAGED_WATCH_MS, Math.min(10000, Math.floor(control.leaseMs / 4)));
  managedWatch = setInterval(() => {
    if (shuttingDown) return;
    try {
      const intent = readLifecycleIntent(control.configFile);
      managedFailureSince = 0;
      if (intent.desiredState !== 'running') {
        void shutdown('shared-lifecycle-stopped', 0);
        return;
      }
      writeManagedHeartbeat();
    } catch (error) {
      const now = Date.now();
      if (!managedFailureSince) managedFailureSince = now;
      const unavailableForMs = now - managedFailureSince;
      fail(`managed lifecycle/lease check failed (${unavailableForMs}ms): ${error?.message || error}`);
      if (error?.code === 'DEVMATE_TUNNEL_OWNER_CHANGED' || unavailableForMs >= MANAGED_CONFIG_FAILURE_GRACE_MS) {
        void shutdown(error?.code === 'DEVMATE_TUNNEL_OWNER_CHANGED' ? 'shared-ownership-changed' : 'shared-state-unavailable', 1);
      }
    }
  }, intervalMs);
  managedWatch.unref?.();
}

async function shutdown(reason = 'shutdown', requestedExitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  stopManagedWatch();
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
    releaseManagedRecord();
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
  const validated = validateStartMessage(message);
  const { command, args, options } = validated;
  control = validated.control;
  if (control) {
    store = new SharedTunnelRecordStore({ stateDirectory: control.stateDirectory, leaseMs: control.leaseMs, logger: fail });
    writeManagedHeartbeat();
  }
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
    stopManagedWatch();
    releaseManagedRecord();
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
  startManagedWatch();
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
  if (message?.type === 'devmate:provider-handoff') {
    try {
      if (!acknowledgeManagedHandoff()) throw new Error('Managed provider handoff is unavailable');
    } catch (error) {
      fail(`provider handoff failed: ${error?.message || error}`);
      void shutdown('handoff-failed', 1);
    }
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

process.once('disconnect', () => {
  if (control) {
    try { process.stdout?.unref?.(); } catch {}
    try { process.stderr?.unref?.(); } catch {}
    return;
  }
  void shutdown('parent-disconnect', 0);
});
process.once('SIGINT', () => { void shutdown('SIGINT', 0); });
process.once('SIGTERM', () => { void shutdown('SIGTERM', 0); });

module.exports = {
  MANAGED_CONFIG_FAILURE_GRACE_MS,
  MANAGED_WATCH_MS,
  acknowledgeManagedHandoff,
  cleanControl,
  cleanOptions,
  validateStartMessage
};
