'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { TunnelRuntimeCoordinator, normalizeConfigurationKey, readTunnelRecord } = require('../host/runtime/tunnel-coordinator.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class Child extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
  }
  kill(signal = 'SIGTERM') {
    if (this.exitCode != null || this.killed) return false;
    this.killed = true;
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit('exit', 0, signal);
    });
    return true;
  }
}

test('stops an owned old configuration before detecting or launching the replacement', async () => {
  const state = temporaryDirectory('devmate-tunnel-reconfigure-');
  const coordinator = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'vscode', leaseMs: 5000 });
  let launches = 0;
  let existingChecks = 0;
  let firstChild;

  const first = await coordinator.start({
    port: 8787,
    provider: 'ngrok',
    configurationKey: 'config-a',
    async launch() {
      launches += 1;
      firstChild = new Child(40001);
      return firstChild;
    },
    async waitReady() { return 'https://a.example'; }
  });
  assert.equal(first.started, true);

  const second = await coordinator.start({
    port: 8787,
    provider: 'ngrok',
    configurationKey: 'config-b',
    async detectExisting() {
      existingChecks += 1;
      return firstChild.killed ? '' : 'https://a.example';
    },
    async launch() {
      launches += 1;
      return new Child(40002);
    },
    async waitReady() { return 'https://b.example'; }
  });

  assert.equal(firstChild.killed, true);
  assert.equal(existingChecks, 0, 'Owned configuration replacement must not reattach to the old endpoint');
  assert.equal(launches, 2);
  assert.equal(second.started, true);
  assert.equal(second.publicUrl, 'https://b.example');
  const record = readTunnelRecord(path.join(state, 'tunnel.runtime.json'));
  assert.equal(record.configurationKey, normalizeConfigurationKey('config-b'));
  assert.equal(record.publicUrl, 'https://b.example');
  await coordinator.dispose({ stopOwned: true });
});

test('reports an explicit not-ready error and cleans the owned process', async () => {
  const state = temporaryDirectory('devmate-tunnel-not-ready-');
  const coordinator = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'vscode' });
  let child;
  await assert.rejects(
    coordinator.start({
      port: 8787,
      provider: 'ngrok',
      configurationKey: 'not-ready',
      async launch() {
        child = new Child(41001);
        return child;
      },
      async waitReady() { return ''; }
    }),
    error => error.code === 'DEVMATE_TUNNEL_NOT_READY'
  );
  assert.equal(child.killed, true);
  assert.equal(coordinator.child, null);
  assert.equal(fs.existsSync(path.join(state, 'tunnel.runtime.json')), false);
});
