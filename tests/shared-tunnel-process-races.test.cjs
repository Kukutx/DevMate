'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { SharedTunnelProcess } = require('../vscode-host/shared-tunnel-process.js');
const { SharedTunnelRuntime } = require('../vscode-host/shared-tunnel-runtime.js');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { virtualHttpRequest } = require('../tunnel-provider.js');

function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for shared tunnel process race')); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

class CloseOnlyChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 93001;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  fail() {
    this.killed = true;
    queueMicrotask(() => {
      this.emit('error', new Error('spawn failed after handle creation'));
      this.emit('close', null, null);
    });
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    queueMicrotask(() => this.emit('close', 0, signal));
    return true;
  }
}

test('a provider that emits error plus close without exit cleans ownership immediately', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-close-only-'));
  const port = 18901;
  atomicWriteJson(path.join(stateDirectory, 'config.json'), { version: 11, server: { port } });
  const child = new CloseOnlyChild();
  const childProcess = { spawn() { return child; } };
  const httpModule = {
    request(_input, options, callback) {
      let effectiveCallback = callback;
      if (typeof options === 'function') effectiveCallback = options;
      return virtualHttpRequest({ statusCode: 200, body: '{"tunnels":[]}', onResponse: effectiveCallback });
    }
  };
  const runtime = new SharedTunnelRuntime({
    stateDirectory,
    childProcess,
    http: httpModule,
    settings: () => ({ provider: 'ngrok' }),
    hostId: 'close-only',
    readyTimeoutMs: 5000
  }).install();
  try {
    const proxy = childProcess.spawn('ngrok', ['http', String(port)], {});
    await waitFor(() => runtime.store.read()?.status === 'pending');
    child.fail();
    await waitFor(() => proxy.finished && runtime.store.read() === null);
    assert.equal(proxy.exitCode, null);
    assert.equal(runtime.status().owned, false);
  } finally {
    runtime.suspendSpawn();
    await runtime.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('Stop during follower recovery is terminal and ignores the later rejection', async () => {
  let resolveRecovery;
  let rejectRecovery;
  const recovery = new Promise((resolve, reject) => {
    resolveRecovery = resolve;
    rejectRecovery = reject;
  });
  let attempts = 0;
  let record = {
    ownerId: 'first-owner',
    hostId: 'first-host',
    port: 8787,
    provider: 'ngrok',
    configurationKey: 'a'.repeat(64)
  };
  let finishedCount = 0;
  const runtime = {
    hostId: 'race-follower',
    attachedPollMs: 50,
    readyTimeoutMs: 1000,
    store: { read: () => record },
    recordMatches: () => true,
    conflictError: () => new Error('conflict'),
    expirePendingOwner: async () => {},
    ownerExited: () => {},
    processFinished: () => { finishedCount += 1; },
    initializeProcess: async processProxy => {
      attempts += 1;
      if (attempts === 1) {
        processProxy.attachFollower(record);
        return;
      }
      return recovery;
    }
  };
  const proxy = new SharedTunnelProcess(runtime, { match: record });
  await waitFor(() => proxy.attached && proxy.started);
  record = null;
  proxy.checkAttachment();
  await waitFor(() => proxy.recovering && attempts === 2);
  assert.equal(proxy.kill('SIGTERM'), true);
  await waitFor(() => proxy.finished && proxy.exitCode === 0);
  rejectRecovery(new Error('late recovery failure'));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(proxy.finished, true);
  assert.equal(proxy.exitCode, 0);
  assert.equal(finishedCount, 1);
  void resolveRecovery;
});
