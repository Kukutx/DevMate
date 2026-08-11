'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { TunnelController } = require('../vscode-host/tunnel-controller.js');

function fakeRequest(payload) {
  return (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.destroy = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(JSON.stringify(payload)));
        response.emit('end');
      });
    };
    return request;
  };
}

function fakeChildProcess(onSpawn) {
  return {
    spawn(command, args) {
      onSpawn(command, args);
      throw new Error('unexpected provider spawn');
    },
    spawnSync(_command, args) {
      if (args[0] === 'version') return { status: 0, stdout: 'ngrok version 3.40.0\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  };
}

function settings(overrides = {}) {
  return { provider: 'ngrok', ngrokCommandPath: 'ngrok', ngrokUseManagedAccount: false, autoRestart: false, maxRestarts: 0, ...overrides };
}

test('reuses an existing local ngrok endpoint for the same Gateway port without spawning or pooling', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-reuse-'));
  let spawns = 0;
  const controller = new TunnelController({
    stateDirectory,
    settings,
    childProcess: fakeChildProcess(() => { spawns += 1; }),
    httpRequest: fakeRequest({ endpoints: [{ name: 'existing', url: 'https://ready.ngrok.app', upstream: { url: 'http://127.0.0.1:8788' }, pooling_enabled: false }] })
  });
  try {
    const started = await controller.start(8788);
    assert.equal(spawns, 0);
    assert.equal(started.publicUrl, 'https://ready.ngrok.app');
    assert.equal(started.attached, true);
    assert.equal(started.owned, false);
    const status = controller.status(8788);
    assert.equal(status.attached, true);
    assert.equal(status.owned, false);
    const stopped = await controller.stop();
    assert.equal(stopped.detached, true);
    assert.equal(stopped.reason, 'detached-existing-provider');
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('does not reuse a local ngrok endpoint when a different stable URL was requested', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-reuse-url-'));
  let spawns = 0;
  const controller = new TunnelController({
    stateDirectory,
    settings: () => settings({ ngrokUrl: 'https://expected.ngrok.app' }),
    childProcess: fakeChildProcess(() => { spawns += 1; }),
    httpRequest: fakeRequest({ endpoints: [{ name: 'other', url: 'https://other.ngrok.app', upstream: { url: 'http://127.0.0.1:8788' } }] })
  });
  try {
    await assert.rejects(() => controller.start(8788), /unexpected provider spawn/);
    assert.equal(spawns, 1);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
