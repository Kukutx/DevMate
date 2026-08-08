'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { recordGeneration } = require('../shared/public-ingress-verification.cjs');
const {
  SharedTunnelRecordStore,
  configurationKey
} = require('../vscode-host/shared-tunnel-record-store.js');

function writeGatewayLock(stateDirectory, owner, acquiredAt) {
  const state = path.join(stateDirectory, 'state');
  fs.mkdirSync(state, { recursive: true });
  atomicWriteJson(path.join(state, 'gateway.lock'), {
    version: 1,
    runtimeOwnerId: owner,
    pid: process.pid,
    parentPid: process.ppid || process.pid,
    instanceId: 'instance-a',
    configPath: path.join(stateDirectory, 'config.json'),
    acquiredAt,
    heartbeatAt: new Date().toISOString(),
    leaseMs: 90000,
    launchMode: 'child_process'
  });
}

const settings = {
  provider: 'external',
  publicUrl: 'https://stable.example.com',
  ngrokUrl: '',
  ngrokCommandPath: 'ngrok',
  ngrokUseManagedAccount: false,
  ngrokPoolingEnabled: false,
  ngrokTrafficPolicyFile: '',
  cloudflareCommandPath: 'cloudflared'
};

test('shared tunnel reads derive session identity from the current live Gateway lock without persisting it', () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-gateway-generation-'));
  try {
    writeGatewayLock(stateDirectory, 'gateway-a', '2026-08-08T01:00:00.000Z');
    const store = new SharedTunnelRecordStore({ stateDirectory });
    const ownerId = 'tunnel-owner';
    store.write(ownerId, {
      hostId: 'vscode-test',
      port: 8787,
      provider: 'external',
      configurationKey: configurationKey(settings, 8787),
      status: 'ready',
      publicUrl: settings.publicUrl,
      readyAt: '2026-08-08T01:00:01.000Z'
    });

    const first = store.read();
    assert.ok(first.gatewayGeneration);
    const firstGeneration = recordGeneration(first);
    assert.ok(firstGeneration);
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'tunnel.runtime.json'), 'utf8'));
    assert.equal(Object.hasOwn(persisted, 'gatewayGeneration'), false);

    writeGatewayLock(stateDirectory, 'gateway-b', '2026-08-08T01:02:00.000Z');
    const second = store.read();
    assert.ok(second.gatewayGeneration);
    assert.notEqual(second.gatewayGeneration, first.gatewayGeneration);
    assert.notEqual(recordGeneration(second), firstGeneration);

    fs.rmSync(path.join(stateDirectory, 'state', 'gateway.lock'), { force: true });
    const noGateway = store.read();
    assert.equal(noGateway.gatewayGeneration, '');
    assert.equal(recordGeneration(noGateway), '');
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});