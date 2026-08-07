'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const {
  TunnelController,
  normalizeSettings
} = require('../vscode-host/tunnel-controller.js');
const {
  MAX_RUNTIME_RECORD_BYTES,
  SharedTunnelRecordStore,
  configurationKey,
  runtimeRecordStale
} = require('../vscode-host/shared-tunnel-record-store.js');

let nextPid = 95000;

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-native-safety-'));
}

function externalSettings(publicUrl = 'https://safe.example.test') {
  return {
    provider: 'external',
    publicUrl,
    deploymentMode: 'production',
    autoRestart: false,
    maxRestarts: 0
  };
}

function quickSettings() {
  return {
    provider: 'cloudflare-quick',
    cloudflareCommandPath: 'cloudflared',
    deploymentMode: 'personal',
    autoRestart: false,
    maxRestarts: 0
  };
}

function validRecord(port, settings = externalSettings(), patch = {}) {
  return {
    version: 1,
    ownerId: 'vscode-owner-123',
    hostId: 'vscode-owner',
    hostPid: process.pid,
    childPid: null,
    port,
    provider: settings.provider,
    configurationKey: configurationKey(settings, port),
    status: 'ready',
    publicUrl: settings.publicUrl || 'https://safe.example.test',
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

function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for provider-native tunnel condition')); return; }
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

  closeOnly() {
    this.killed = true;
    queueMicrotask(() => {
      this.emit('error', new Error('provider closed without exit'));
      this.emit('close', null, null);
    });
  }
}

test('current tunnel settings accept 100 restarts but reject malformed values', () => {
  assert.equal(normalizeSettings({ provider: 'external', maxRestarts: 100 }).maxRestarts, 100);
  assert.throws(() => normalizeSettings({ provider: 'external', maxRestarts: 101 }), /0 to 100/);
  assert.throws(() => normalizeSettings({ provider: 'external', autoRestart: 'false' }), /must be a boolean/);
});

test('preserves future shared tunnel records byte-for-byte', () => {
  const stateDirectory = tempState();
  try {
    const store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: 30000 });
    const future = `${JSON.stringify(validRecord(8787, externalSettings(), { version: 99 }), null, 2)}\n`;
    fs.writeFileSync(store.recordFile, future, 'utf8');
    assert.throws(
      () => store.read(),
      error => error?.code === 'DEVMATE_TUNNEL_RECORD_FUTURE_VERSION' && error.recordFile === store.recordFile
    );
    assert.equal(fs.readFileSync(store.recordFile, 'utf8'), future);
    assert.deepEqual(quarantineFiles(stateDirectory), []);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('quarantines malformed, unsafe, and oversized runtime records', () => {
  const stateDirectory = tempState();
  try {
    const store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: 30000 });
    fs.writeFileSync(store.recordFile, '{bad-json', 'utf8');
    assert.equal(store.read(), null);
    assert.equal(quarantineFiles(stateDirectory).length, 1);

    atomicWriteJson(store.recordFile, validRecord(8787, externalSettings(), { publicUrl: 'http://unsafe.example.test' }));
    assert.equal(store.read(), null);
    assert.equal(quarantineFiles(stateDirectory).length, 2);

    fs.writeFileSync(store.recordFile, 'x'.repeat(MAX_RUNTIME_RECORD_BYTES + 1), 'utf8');
    assert.equal(store.read(), null);
    assert.equal(quarantineFiles(stateDirectory).length, 3);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('stale dead-owner records are removed before a new owner starts', () => {
  const stateDirectory = tempState();
  try {
    const store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: 30000 });
    const record = validRecord(8787, externalSettings(), {
      ownerId: 'dead-owner',
      hostId: 'dead-host',
      hostPid: 2147483647,
      acquiredAt: new Date(0).toISOString(),
      readyAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString()
    });
    atomicWriteJson(store.recordFile, record);
    assert.equal(runtimeRecordStale({ ...record, mtimeMs: 0 }, { at: Date.now(), leaseMs: 30000 }), true);
    assert.equal(store.read(), null);
    assert.equal(fs.existsSync(store.recordFile), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('invalid runtime record paths fail before any provider launch', async () => {
  const stateDirectory = tempState();
  const store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: 30000 });
  fs.mkdirSync(store.recordFile);
  let spawnCount = 0;
  const childProcess = {
    spawn() { spawnCount += 1; return new FakeChild(); },
    spawnSync() { return { status: 0, stdout: '', stderr: '', error: null }; }
  };
  const controller = new TunnelController({ stateDirectory, settings: quickSettings, childProcess });
  try {
    await assert.rejects(
      controller.start(8787),
      error => error?.code === 'DEVMATE_TUNNEL_RECORD_PATH_INVALID' && error.recordFile === store.recordFile
    );
    assert.equal(spawnCount, 0);
    assert.equal(fs.statSync(store.recordFile).isDirectory(), true);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('provider launch failure clears owner state, record, and startup lease', async () => {
  const stateDirectory = tempState();
  const childProcess = {
    spawn() { throw new Error('provider launch failed'); },
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; }
  };
  const controller = new TunnelController({ stateDirectory, settings: quickSettings, childProcess, startTimeoutMs: 1500 });
  try {
    await assert.rejects(controller.start(8787), /provider launch failed/);
    assert.equal(controller.ownerId, '');
    assert.equal(controller.child, null);
    assert.equal(controller.port, 0);
    assert.equal(controller.store.read(), null);
    assert.equal(fs.existsSync(path.join(stateDirectory, 'tunnel.start.lock')), false);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('readiness timeout terminates the provider and clears ownership', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild();
  const childProcess = {
    spawn() { return child; },
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: quickSettings,
    childProcess,
    readyTimeoutMs: 1000,
    startTimeoutMs: 2000
  });
  try {
    await assert.rejects(controller.start(8787), error => error?.code === 'DEVMATE_TUNNEL_READY_TIMEOUT');
    assert.equal(child.killed, true);
    assert.equal(controller.ownerId, '');
    assert.equal(controller.store.read(), null);
    assert.equal(fs.existsSync(path.join(stateDirectory, 'tunnel.start.lock')), false);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('error plus close without exit removes a ready provider owner exactly once', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild();
  const childProcess = {
    spawn() {
      setTimeout(() => child.stdout.write('Ready https://native-close-only.trycloudflare.com\n'), 25);
      return child;
    },
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: quickSettings,
    childProcess,
    readyTimeoutMs: 2000
  });
  try {
    const started = await controller.start(8787);
    assert.equal(started.owned, true);
    assert.equal(started.publicUrl, 'https://native-close-only.trycloudflare.com');
    child.closeOnly();
    await waitFor(() => controller.ownerId === '' && controller.store.read() === null);
    assert.equal(controller.child, null);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('configuration conflict is rejected before a second provider can own the tunnel', async () => {
  const stateDirectory = tempState();
  const first = new TunnelController({ stateDirectory, settings: () => externalSettings('https://first.example.test'), hostId: 'first' });
  const second = new TunnelController({ stateDirectory, settings: () => externalSettings('https://second.example.test'), hostId: 'second' });
  try {
    assert.equal((await first.start(8787)).owned, true);
    await assert.rejects(
      second.start(8787),
      error => error?.code === 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT'
    );
    assert.equal(first.status(8787).publicUrl, 'https://first.example.test');
  } finally {
    await first.dispose({ stopOwned: true }).catch(() => {});
    await second.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
