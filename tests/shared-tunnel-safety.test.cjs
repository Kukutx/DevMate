'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  MAX_CAPTURE_BYTES,
  MAX_RUNTIME_RECORD_BYTES,
  SharedTunnelRecordStore,
  SharedTunnelRuntime,
  configurationKey
} = require('../vscode-host/shared-tunnel-runtime.js');
const { atomicWriteJson } = require('../host/runtime/config-store.js');
const { virtualHttpRequest } = require('../tunnel-provider.js');

function tempState(port = 8787) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-safety-'));
  atomicWriteJson(path.join(stateDirectory, 'config.json'), { version: 11, server: { port } });
  return { stateDirectory, port };
}

function settings() {
  return {
    provider: 'ngrok',
    publicUrl: '',
    ngrokUrl: '',
    ngrokCommandPath: '',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: '',
    deploymentMode: 'personal'
  };
}

function validRecord(port, patch = {}) {
  return {
    version: 1,
    ownerId: 'vscode-owner-123',
    hostId: 'vscode-owner',
    hostPid: process.pid,
    childPid: 90123,
    port,
    provider: 'ngrok',
    configurationKey: configurationKey(settings(), port),
    status: 'ready',
    publicUrl: 'https://safe.example.test',
    acquiredAt: new Date().toISOString(),
    readyAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    leaseMs: 30000,
    ...patch
  };
}

function quarantineFiles(stateDirectory) {
  return fs.readdirSync(stateDirectory).filter(name => name.startsWith('tunnel.runtime.json.'));
}

function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for shared tunnel safety condition')); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 90210;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = 'SIGTERM') {
    if (this.killed || this.exitCode != null) return true;
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit('exit', 0, signal);
      this.emit('close', 0, signal);
    });
    return true;
  }
}

test('preserves future shared tunnel records byte-for-byte', () => {
  const state = tempState();
  try {
    const store = new SharedTunnelRecordStore({ stateDirectory: state.stateDirectory, leaseMs: 30000 });
    const future = `${JSON.stringify(validRecord(state.port, { version: 99 }), null, 2)}\n`;
    fs.writeFileSync(store.recordFile, future, 'utf8');
    assert.throws(
      () => store.read(),
      error => error?.code === 'DEVMATE_TUNNEL_RECORD_FUTURE_VERSION' && error.recordFile === store.recordFile
    );
    assert.equal(fs.readFileSync(store.recordFile, 'utf8'), future);
    assert.deepEqual(quarantineFiles(state.stateDirectory), []);
  } finally {
    fs.rmSync(state.stateDirectory, { recursive: true, force: true });
  }
});

test('refuses a directory placed at the runtime record path before provider spawn', async () => {
  const state = tempState();
  const store = new SharedTunnelRecordStore({ stateDirectory: state.stateDirectory, leaseMs: 30000 });
  fs.mkdirSync(store.recordFile);
  let spawnCount = 0;
  const childProcess = { spawn() { spawnCount += 1; return new FakeChild(); } };
  const httpModule = {
    request(_input, _options, callback) {
      return virtualHttpRequest({ statusCode: 200, body: '{"tunnels":[]}', onResponse: callback });
    }
  };
  const runtime = new SharedTunnelRuntime({
    ...state,
    childProcess,
    http: httpModule,
    settings,
    hostId: 'vscode-record-directory',
    startTimeoutMs: 1000,
    readyTimeoutMs: 250
  }).install();
  try {
    const proxy = childProcess.spawn('ngrok', ['http', String(state.port)], {});
    let error = null;
    proxy.once('error', value => { error = value; });
    await waitFor(() => proxy.exitCode === 1);
    assert.equal(error?.code, 'DEVMATE_TUNNEL_RECORD_PATH_INVALID');
    assert.equal(spawnCount, 0);
    assert.equal(fs.statSync(store.recordFile).isDirectory(), true);
  } finally {
    runtime.suspendSpawn();
    await runtime.dispose({ stopOwned: true });
    fs.rmSync(state.stateDirectory, { recursive: true, force: true });
  }
});

test('quarantines malformed, unsafe, and oversized runtime records', () => {
  const state = tempState();
  try {
    const store = new SharedTunnelRecordStore({ stateDirectory: state.stateDirectory, leaseMs: 30000 });

    fs.writeFileSync(store.recordFile, '{bad-json', 'utf8');
    assert.equal(store.read(), null);
    assert.equal(fs.existsSync(store.recordFile), false);
    assert.equal(quarantineFiles(state.stateDirectory).length, 1);

    atomicWriteJson(store.recordFile, validRecord(state.port, { publicUrl: 'http://unsafe.example.test' }));
    assert.equal(store.read(), null);
    assert.equal(fs.existsSync(store.recordFile), false);
    assert.equal(quarantineFiles(state.stateDirectory).length, 2);

    fs.writeFileSync(store.recordFile, 'x'.repeat(MAX_RUNTIME_RECORD_BYTES + 1), 'utf8');
    assert.equal(store.read(), null);
    assert.equal(fs.existsSync(store.recordFile), false);
    assert.equal(quarantineFiles(state.stateDirectory).length, 3);
  } finally {
    fs.rmSync(state.stateDirectory, { recursive: true, force: true });
  }
});

test('kills and cleans an owner that never publishes a bounded valid URL', async () => {
  const state = tempState();
  const child = new FakeChild();
  const childProcess = { spawn() { return child; } };
  const oversized = JSON.stringify({
    tunnels: [{
      name: 'oversized',
      public_url: 'https://ignored.example.test',
      proto: 'https',
      config: { addr: `http://127.0.0.1:${state.port}` },
      padding: 'x'.repeat(MAX_CAPTURE_BYTES + 1024)
    }]
  });
  const httpModule = {
    request(_input, options, callback) {
      let effectiveCallback = callback;
      if (typeof options === 'function') effectiveCallback = options;
      return virtualHttpRequest({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: oversized,
        onResponse: effectiveCallback
      });
    }
  };
  const runtime = new SharedTunnelRuntime({
    ...state,
    childProcess,
    http: httpModule,
    settings,
    hostId: 'vscode-readiness-timeout',
    startTimeoutMs: 1000,
    readyTimeoutMs: 250,
    heartbeatMs: 5000
  }).install();
  try {
    const proxy = childProcess.spawn('ngrok', ['http', String(state.port)], {});
    await waitFor(() => runtime.store.read()?.status === 'pending');
    const request = httpModule.request('http://127.0.0.1:4040/api/tunnels', {}, response => response.resume());
    request.end();
    await waitFor(() => child.killed && proxy.exitCode === 0 && !runtime.store.read());
    assert.equal(fs.existsSync(path.join(state.stateDirectory, 'tunnel.start.lock')), false);
  } finally {
    runtime.suspendSpawn();
    await runtime.dispose({ stopOwned: true });
    fs.rmSync(state.stateDirectory, { recursive: true, force: true });
  }
});
