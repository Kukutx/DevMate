'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { TunnelController } = require('../vscode-host/tunnel-controller.js');

function noLocalAgentRequest(url, options, callback) {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  req.end = () => {
    if (String(options?.method || 'GET').toUpperCase() === 'DELETE') throw new Error('ERR334 recovery must never delete an endpoint');
    const res = new EventEmitter();
    res.statusCode = 404;
    res.destroy = () => {};
    callback(res);
    queueMicrotask(() => res.emit('end'));
  };
  return req;
}

function conflictChildProcess(spawnCounter) {
  return {
    spawn() {
      spawnCounter.count += 1;
      const child = new EventEmitter();
      child.pid = 43210;
      child.exitCode = null;
      child.signalCode = null;
      child.killed = false;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => { child.exitCode = 1; queueMicrotask(() => child.emit('close', 1, null)); return true; };
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from("ERROR: failed to start tunnel: The endpoint 'https://assigned.ngrok-free.app' is already online.\nERROR: ERR_NGROK_334\n"));
        child.exitCode = 1;
        child.emit('close', 1, null);
      });
      return child;
    },
    spawnSync(_command, args) {
      if (args[0] === 'version') return { status:0, stdout:'ngrok version 3.39.9\n', stderr:'' };
      if (args[0] === 'config' && args[1] === 'check') return { status:1, stdout:'', stderr:'' };
      return { status:1, stdout:'', stderr:'' };
    }
  };
}

function settings() {
  return { provider:'ngrok', ngrokCommandPath:'ngrok', ngrokUseManagedAccount:false, ngrokPoolingEnabled:false, autoRestart:false, maxRestarts:0 };
}

test('ERR_NGROK_334 with no local Agent candidate adopts the already-online URL only after current-Gateway verification', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-conflict-adopt-'));
  const spawns = { count:0 };
  const verified = [];
  const controller = new TunnelController({
    stateDirectory,
    settings,
    childProcess: conflictChildProcess(spawns),
    httpRequest: noLocalAgentRequest,
    verifyExistingEndpoint: async ({ publicUrl, port, reason }) => {
      verified.push({ publicUrl, port, reason });
      return publicUrl === 'https://assigned.ngrok-free.app' && port === 8788;
    },
    readyTimeoutMs:1000,
    startTimeoutMs:2000
  });
  try {
    const started = await controller.start(8788);
    assert.equal(spawns.count, 1);
    assert.equal(started.publicUrl, 'https://assigned.ngrok-free.app');
    assert.equal(started.attached, true);
    assert.equal(started.owned, false);
    assert.equal(controller.diagnosticSnapshot(8788).borrowedPublicVerified, true);
    assert.deepEqual(verified[0], { publicUrl:'https://assigned.ngrok-free.app', port:8788, reason:'endpoint-conflict' });
    const stopped = await controller.stop();
    assert.equal(stopped.detached, true);
  } finally {
    await controller.dispose({ stopOwned:true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive:true, force:true });
  }
});

test('ERR_NGROK_334 is left untouched when the already-online URL does not verify as the current Gateway', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-conflict-reject-'));
  const spawns = { count:0 };
  const controller = new TunnelController({
    stateDirectory,
    settings,
    childProcess: conflictChildProcess(spawns),
    httpRequest: noLocalAgentRequest,
    verifyExistingEndpoint: async () => false,
    readyTimeoutMs:1000,
    startTimeoutMs:2000
  });
  try {
    await assert.rejects(() => controller.start(8788), error => {
      assert.equal(error.code, 'DEVMATE_NGROK_ENDPOINT_CONFLICT');
      assert.equal(error.conflictUrl, 'https://assigned.ngrok-free.app');
      assert.match(error.message, /Stop the old endpoint in the ngrok dashboard, then click Start again/);
      assert.match(error.message, /local Gateway remains available for retry/);
      assert.doesNotMatch(error.message, /Provider output|start both endpoints|--pooling-enabled/);
      return true;
    });
    assert.equal(spawns.count, 1);
  } finally {
    await controller.dispose({ stopOwned:true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive:true, force:true });
  }
});
