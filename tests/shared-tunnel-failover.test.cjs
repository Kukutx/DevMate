'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { SharedTunnelRuntime } = require('../vscode-host/shared-tunnel-runtime.js');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { virtualHttpRequest } = require('../tunnel-provider.js');

let nextPid = 92000;

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

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for tunnel failover')); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function requestJson(httpModule, url) {
  return new Promise((resolve, reject) => {
    const request = httpModule.request(url, {}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, json: text ? JSON.parse(text) : null });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function providerRequest(publicUrl, port) {
  return (_input, options, callback) => {
    let effectiveCallback = callback;
    if (typeof options === 'function') effectiveCallback = options;
    return virtualHttpRequest({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tunnels: [{
          name: 'failover-provider',
          public_url: publicUrl,
          proto: 'https',
          config: { addr: `http://127.0.0.1:${port}` }
        }]
      }),
      onResponse: effectiveCallback
    });
  };
}

test('a pending follower takes ownership once when the first owner exits', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-failover-'));
  const port = 18888;
  const publicUrl = 'https://failover.example.test';
  atomicWriteJson(path.join(stateDirectory, 'config.json'), { version: 11, server: { port } });

  const children = [];
  const launch = () => {
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const cpA = { spawn: launch };
  const cpB = { spawn: launch };
  const httpA = { request: providerRequest(publicUrl, port) };
  const httpB = { request: providerRequest(publicUrl, port) };
  const settings = () => ({ provider: 'ngrok', deploymentMode: 'personal' });
  const runtimeA = new SharedTunnelRuntime({
    stateDirectory,
    childProcess: cpA,
    http: httpA,
    settings,
    hostId: 'failover-a',
    attachedPollMs: 50,
    readyTimeoutMs: 3000
  }).install();
  const runtimeB = new SharedTunnelRuntime({
    stateDirectory,
    childProcess: cpB,
    http: httpB,
    settings,
    hostId: 'failover-b',
    attachedPollMs: 50,
    readyTimeoutMs: 3000
  }).install();

  try {
    const processA = cpA.spawn('ngrok', ['http', String(port)], {});
    const processB = cpB.spawn('ngrok', ['http', String(port)], {});
    await waitFor(() =>
      children.length === 1 &&
      (processA.owned || processB.owned) &&
      (processA.attached || processB.attached)
    );
    const firstOwner = processA.owned ? processA : processB;
    const firstFollower = processA.owned ? processB : processA;
    const followerRuntime = processA.owned ? runtimeB : runtimeA;
    const followerHttp = processA.owned ? httpB : httpA;

    assert.equal(firstFollower.attached, true);
    children[0].kill('SIGTERM');
    await waitFor(() => firstOwner.finished && children.length === 2 && firstFollower.owned);
    assert.equal(firstFollower.recoveryCount, 1);
    assert.equal(firstFollower.finished, false);
    assert.equal(followerRuntime.store.read()?.ownerId, firstFollower.ownerId);

    const providerView = await requestJson(followerHttp, 'http://127.0.0.1:4040/api/tunnels');
    assert.equal(providerView.status, 200);
    await waitFor(() => followerRuntime.store.read()?.status === 'ready');
    assert.equal(followerRuntime.store.read().publicUrl, publicUrl);

    firstFollower.kill('SIGTERM');
    await waitFor(() => children[1].killed && !followerRuntime.store.read());
    assert.equal(fs.existsSync(path.join(stateDirectory, 'tunnel.start.lock')), false);
  } finally {
    runtimeA.suspendSpawn();
    runtimeB.suspendSpawn();
    await runtimeA.dispose({ stopOwned: true }).catch(() => {});
    await runtimeB.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
