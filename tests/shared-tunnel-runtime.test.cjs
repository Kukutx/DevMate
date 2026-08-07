'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  SharedTunnelRecordStore,
  SharedTunnelRuntime,
  configurationKey,
  runtimeRecordStale
} = require('../vscode-host/shared-tunnel-runtime.js');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { virtualHttpRequest } = require('../tunnel-provider.js');

let nextPid = 70000;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = nextPid++;
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

function tempState(port = 8787) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shared-tunnel-'));
  const configFile = path.join(stateDirectory, 'config.json');
  atomicWriteJson(configFile, { version: 11, server: { port } });
  return { stateDirectory, configFile, port };
}

function providerRequest(publicUrl, port) {
  return (input, options, callback) => {
    let effectiveOptions = options;
    let effectiveCallback = callback;
    if (typeof options === 'function') {
      effectiveCallback = options;
      effectiveOptions = {};
    }
    const target = new URL(typeof input === 'string' ? input : input.href || String(input));
    const method = String(effectiveOptions?.method || 'GET').toUpperCase();
    if (target.pathname === '/api/tunnels' && method === 'GET') {
      return virtualHttpRequest({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tunnels: [{
            name: 'provider-tunnel',
            public_url: publicUrl,
            proto: 'https',
            config: { addr: `http://127.0.0.1:${port}` }
          }]
        }),
        onResponse: effectiveCallback
      });
    }
    if (target.pathname.startsWith('/api/tunnels/') && method === 'DELETE') {
      return virtualHttpRequest({ statusCode: 204, onResponse: effectiveCallback });
    }
    return virtualHttpRequest({ statusCode: 404, onResponse: effectiveCallback });
  };
}

function requestJson(httpModule, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpModule.request(url, { method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for test condition')); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function settings(provider = 'ngrok') {
  return {
    provider,
    publicUrl: provider === 'external' ? 'https://external.example.test' : '',
    ngrokUrl: '',
    ngrokCommandPath: '',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: '',
    deploymentMode: 'personal'
  };
}

function createRuntimePair({ providerA = 'ngrok', providerB = 'ngrok', spawnImpl } = {}) {
  const state = tempState();
  const publicUrl = 'https://shared-tunnel.example.test';
  let spawnCount = 0;
  let actualChild = null;
  const launch = spawnImpl || (() => {
    spawnCount += 1;
    actualChild = new FakeChild();
    return actualChild;
  });
  const cpA = { spawn: launch };
  const cpB = { spawn: launch };
  const httpA = { request: providerRequest(publicUrl, state.port) };
  const httpB = { request: providerRequest(publicUrl, state.port) };
  const runtimeA = new SharedTunnelRuntime({
    ...state,
    childProcess: cpA,
    http: httpA,
    settings: () => settings(providerA),
    hostId: 'vscode-a',
    runtimeLeaseMs: 30000,
    heartbeatMs: 5000,
    attachedPollMs: 100
  }).install();
  const runtimeB = new SharedTunnelRuntime({
    ...state,
    childProcess: cpB,
    http: httpB,
    settings: () => settings(providerB),
    hostId: 'vscode-b',
    runtimeLeaseMs: 30000,
    heartbeatMs: 5000,
    attachedPollMs: 100
  }).install();
  return {
    ...state,
    publicUrl,
    cpA,
    cpB,
    httpA,
    httpB,
    runtimeA,
    runtimeB,
    get spawnCount() { return spawnCount; },
    get actualChild() { return actualChild; }
  };
}

async function cleanup(pair) {
  try { pair.runtimeA.suspendSpawn(); } catch {}
  try { pair.runtimeB.suspendSpawn(); } catch {}
  try { await pair.runtimeA.dispose({ stopOwned: true }); } catch {}
  try { await pair.runtimeB.dispose({ stopOwned: true }); } catch {}
  fs.rmSync(pair.stateDirectory, { recursive: true, force: true });
}

test('two VS Code hosts converge on one tunnel and followers cannot stop the owner', async () => {
  const pair = createRuntimePair();
  try {
    const processA = pair.cpA.spawn('ngrok', ['http', String(pair.port)], {});
    const processB = pair.cpB.spawn('ngrok', ['http', String(pair.port)], {});
    await waitFor(() => pair.spawnCount === 1 && (processA.owned || processB.owned));
    const ownerRuntime = processA.owned ? pair.runtimeA : pair.runtimeB;
    const ownerHttp = processA.owned ? pair.httpA : pair.httpB;
    const followerHttp = processA.owned ? pair.httpB : pair.httpA;
    const ownerProcess = processA.owned ? processA : processB;
    const followerProcess = processA.owned ? processB : processA;

    const provider = await requestJson(ownerHttp, 'http://127.0.0.1:4040/api/tunnels');
    assert.equal(provider.status, 200);
    await waitFor(() => ownerRuntime.store.read()?.status === 'ready');

    const followerView = await requestJson(followerHttp, 'http://127.0.0.1:4040/api/tunnels');
    assert.equal(followerView.status, 200);
    assert.equal(followerView.json.tunnels[0].public_url, pair.publicUrl);
    assert.equal(pair.spawnCount, 1);

    const deletion = await requestJson(followerHttp, 'http://127.0.0.1:4040/api/tunnels/devmate-shared-tunnel', 'DELETE');
    assert.equal(deletion.status, 204);
    assert.equal(pair.actualChild.killed, false);
    assert.ok(ownerRuntime.store.read());

    followerProcess.kill();
    await waitFor(() => followerProcess.exitCode === 0);
    assert.equal(pair.actualChild.killed, false);

    ownerProcess.kill();
    await waitFor(() => pair.actualChild.killed && !ownerRuntime.store.read());
  } finally {
    await cleanup(pair);
  }
});

test('an active tunnel with different settings fails synchronously before a duplicate spawn', async () => {
  const pair = createRuntimePair({ providerA: 'ngrok', providerB: 'external' });
  try {
    pair.cpA.spawn('ngrok', ['http', String(pair.port)], {});
    await waitFor(() => pair.runtimeA.store.read());
    assert.throws(
      () => pair.cpB.spawn('ngrok', ['http', String(pair.port)], {}),
      error => error?.code === 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT'
    );
    assert.equal(pair.spawnCount, 1);
  } finally {
    await cleanup(pair);
  }
});

test('provider launch failure releases the startup lease and leaves no runtime record', async () => {
  const state = tempState();
  const cp = { spawn() { throw new Error('provider launch failed'); } };
  const httpModule = { request: providerRequest('https://unused.example.test', state.port) };
  const runtime = new SharedTunnelRuntime({
    ...state,
    childProcess: cp,
    http: httpModule,
    settings: () => settings('ngrok'),
    hostId: 'vscode-failure',
    startTimeoutMs: 2000
  }).install();
  try {
    const processProxy = cp.spawn('ngrok', ['http', String(state.port)], {});
    await waitFor(() => processProxy.exitCode === 1);
    assert.equal(runtime.store.read(), null);
    assert.equal(fs.existsSync(path.join(state.stateDirectory, 'tunnel.start.lock')), false);
  } finally {
    runtime.suspendSpawn();
    await runtime.dispose({ stopOwned: true });
    fs.rmSync(state.stateDirectory, { recursive: true, force: true });
  }
});

test('stale and dead-owner runtime records are recoverable', () => {
  const state = tempState();
  try {
    const store = new SharedTunnelRecordStore({ stateDirectory: state.stateDirectory, leaseMs: 30000 });
    atomicWriteJson(store.recordFile, {
      version: 1,
      ownerId: 'dead-owner',
      hostId: 'vscode-dead',
      hostPid: 2147483647,
      childPid: null,
      port: state.port,
      provider: 'ngrok',
      configurationKey: configurationKey(settings('ngrok'), state.port),
      status: 'ready',
      publicUrl: 'https://stale.example.test',
      acquiredAt: new Date(0).toISOString(),
      readyAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      leaseMs: 30000
    });
    const raw = { ...JSON.parse(fs.readFileSync(store.recordFile, 'utf8')), mtimeMs: 0 };
    assert.equal(runtimeRecordStale(raw, { at: Date.now(), leaseMs: 30000 }), true);
    assert.equal(store.read(), null);
    assert.equal(fs.existsSync(store.recordFile), false);
  } finally {
    fs.rmSync(state.stateDirectory, { recursive: true, force: true });
  }
});
