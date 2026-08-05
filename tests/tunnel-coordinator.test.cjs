'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  TunnelRuntimeCoordinator,
  normalizeConfigurationKey,
  readTunnelRecord,
  tunnelRecordStale
} = require('../host/runtime/tunnel-coordinator.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class FakeTunnelChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.exitCode = null;
    this.killed = false;
    this.forceTerminated = false;
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
  forceTerminate() {
    this.forceTerminated = true;
    return this.kill('SIGKILL');
  }
}

function startOptions({ port = 8787, provider = 'ngrok', configurationKey = 'default', url = 'https://example.ngrok.app', launchCounter }) {
  return {
    port,
    provider,
    configurationKey,
    timeoutMs: 3000,
    async launch() {
      launchCounter.count += 1;
      return new FakeTunnelChild(10000 + launchCounter.count);
    },
    async waitReady() {
      await new Promise(resolve => setTimeout(resolve, 40));
      return url;
    }
  };
}

test('two hosts converge on one public tunnel and only the owner can stop it', async () => {
  const state = temporaryDirectory('devmate-tunnel-shared-');
  const launches = { count: 0 };
  const vscode = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'vscode', leaseMs: 5000, heartbeatMs: 1000 });
  const secondWindow = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'vscode-window-2', leaseMs: 5000, heartbeatMs: 1000 });
  const options = startOptions({ launchCounter: launches });

  const [first, second] = await Promise.all([vscode.start(options), secondWindow.start(options)]);
  assert.equal(launches.count, 1);
  assert.equal([first, second].filter(result => result.started).length, 1);
  assert.equal([first, second].filter(result => result.attached).length, 1);
  const owner = first.started ? vscode : secondWindow;
  const follower = first.started ? secondWindow : vscode;
  const record = readTunnelRecord(path.join(state, 'tunnel.runtime.json'));
  assert.equal(record.publicUrl, 'https://example.ngrok.app');
  assert.equal(record.configurationKey, normalizeConfigurationKey('default'));
  assert.equal(fs.existsSync(path.join(state, 'tunnel.start.lock')), false);

  const followerStop = await follower.stop();
  assert.equal(followerStop.stopped, false);
  assert.equal(followerStop.reason, 'managed-by-another-host');
  assert.equal((await owner.stop()).stopped, true);
  assert.equal(fs.existsSync(path.join(state, 'tunnel.runtime.json')), false);
  await follower.dispose();
  await owner.dispose();
});

test('refuses a conflicting tunnel configuration owned by another host', async () => {
  const state = temporaryDirectory('devmate-tunnel-conflict-');
  const launches = { count: 0 };
  const first = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'first' });
  const second = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'second' });
  await first.start(startOptions({ configurationKey: 'config-a', launchCounter: launches }));

  await assert.rejects(
    second.start(startOptions({ configurationKey: 'config-b', launchCounter: launches })),
    error => error.code === 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT'
  );
  assert.equal(launches.count, 1);
  await first.dispose({ stopOwned: true });
  await second.dispose();
});

test('cleans the child and runtime record when readiness throws', async () => {
  const state = temporaryDirectory('devmate-tunnel-readiness-');
  const coordinator = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'failure' });
  let child;
  await assert.rejects(
    coordinator.start({
      port: 8787,
      provider: 'ngrok',
      configurationKey: 'failure',
      timeoutMs: 2000,
      async launch() {
        child = new FakeTunnelChild(12345);
        return child;
      },
      async waitReady() {
        throw new Error('synthetic readiness failure');
      }
    }),
    /synthetic readiness failure/
  );
  assert.equal(child.killed, true);
  assert.equal(coordinator.child, null);
  assert.equal(coordinator.ownerId, '');
  assert.equal(fs.existsSync(path.join(state, 'tunnel.runtime.json')), false);
  assert.equal(fs.existsSync(path.join(state, 'tunnel.start.lock')), false);
});

test('does not leave owner state when launch itself throws', async () => {
  const state = temporaryDirectory('devmate-tunnel-launch-');
  const coordinator = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'failure' });
  await assert.rejects(
    coordinator.start({
      port: 8787,
      provider: 'ngrok',
      configurationKey: 'failure',
      async launch() { throw new Error('synthetic launch failure'); },
      async waitReady() { return 'https://unused.example'; }
    }),
    /synthetic launch failure/
  );
  assert.equal(coordinator.child, null);
  assert.equal(coordinator.ownerId, '');
  assert.equal(coordinator.record, null);
});

test('recovers stale records and rejects non-HTTPS public URLs', async () => {
  const state = temporaryDirectory('devmate-tunnel-stale-');
  const recordFile = path.join(state, 'tunnel.runtime.json');
  const old = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(recordFile, JSON.stringify({
    version: 1,
    ownerId: 'old-owner',
    hostId: 'old-host',
    hostPid: process.pid,
    port: 8787,
    provider: 'ngrok',
    configurationKey: normalizeConfigurationKey('old'),
    publicUrl: 'https://old.example',
    acquiredAt: old,
    heartbeatAt: old,
    leaseMs: 5000
  }));
  const oldDate = new Date(Date.now() - 60000);
  fs.utimesSync(recordFile, oldDate, oldDate);
  assert.equal(tunnelRecordStale(readTunnelRecord(recordFile), { leaseMs: 5000 }), true);

  const launches = { count: 0 };
  const coordinator = new TunnelRuntimeCoordinator({ stateDirectory: state, hostId: 'new', leaseMs: 5000 });
  const result = await coordinator.start(startOptions({ configurationKey: 'new', launchCounter: launches }));
  assert.equal(result.started, true);
  assert.equal(launches.count, 1);
  await coordinator.stop();

  await assert.rejects(
    coordinator.start(startOptions({ configurationKey: 'http', url: 'http://unsafe.example', launchCounter: launches })),
    error => error.code === 'DEVMATE_TUNNEL_PUBLIC_URL_INVALID'
  );
  assert.equal(coordinator.child, null);
  assert.equal(fs.existsSync(recordFile), false);
});
