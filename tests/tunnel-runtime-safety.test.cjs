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
  childActive,
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

class StubbornChild extends FakeChild {
  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    return true;
  }
}

test('current tunnel settings accept 100 restarts but reject malformed values', () => {
  assert.equal(normalizeSettings({ provider: 'external', maxRestarts: 100 }).maxRestarts, 100);
  assert.throws(() => normalizeSettings({ provider: 'external', maxRestarts: 101 }), /0 to 100/);
  assert.throws(() => normalizeSettings({ provider: 'external', autoRestart: 'false' }), /must be a boolean/);
});

test('sending a kill signal does not count as provider exit', () => {
  const child = new FakeChild();
  child.killed = true;
  assert.equal(child.exitCode, null);
  assert.equal(childActive(child), true);
  child.exitCode = 0;
  assert.equal(childActive(child), false);
});

test('external provider does not depend on unrelated secret storage', async () => {
  const stateDirectory = tempState();
  const controller = new TunnelController({
    stateDirectory,
    settings: externalSettings,
    getSecrets: async () => { throw new Error('secret storage unavailable'); }
  });
  try {
    const started = await controller.start(8787);
    assert.equal(started.owned, true);
    assert.equal(started.publicUrl, 'https://safe.example.test');
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
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

test('failed startup cleanup preserves a live provider for explicit retry', async () => {
  const stateDirectory = tempState();
  const child = new StubbornChild();
  const childProcess = {
    spawn() { return child; },
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: quickSettings,
    childProcess,
    readyTimeoutMs: 1000,
    startTimeoutMs: 2000,
    stopTimeoutMs: 100,
    forceStopTimeoutMs: 100
  });
  let ownerId = '';
  try {
    await assert.rejects(
      controller.start(8787),
      error => error?.code === 'DEVMATE_TUNNEL_READY_TIMEOUT' && error.cleanupPending === true
    );
    ownerId = controller.ownerId;
    assert.ok(ownerId);
    assert.equal(controller.child, child);
    assert.equal(childActive(child), true);
    assert.equal(controller.store.read()?.ownerId, ownerId);
  } finally {
    child.exitCode = 0;
    child.emit('exit', 0, 'SIGKILL');
    child.emit('close', 0, 'SIGKILL');
    await waitFor(() => controller.ownerId === '' && controller.store.read() === null).catch(() => {});
    await controller.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('error plus close without exit removes a ready provider owner exactly once', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild();
  const childProcess = {
    spawn() {
      setTimeout(() => child.stdout.write('Ready https://native-close-only.trycloudflare.com\nRegistered tunnel connection\n'), 25);
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

test('stop timeout preserves a live provider and shared ownership', async () => {
  const stateDirectory = tempState();
  const child = new StubbornChild();
  const childProcess = {
    spawn() {
      setTimeout(() => child.stdout.write('Ready https://stubborn.trycloudflare.com\nRegistered tunnel connection\n'), 25);
      return child;
    },
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: quickSettings,
    childProcess,
    readyTimeoutMs: 2000,
    stopTimeoutMs: 100,
    forceStopTimeoutMs: 100
  });
  try {
    const started = await controller.start(8787);
    const ownerId = controller.ownerId;
    assert.equal(started.owned, true);
    assert.deepEqual(await controller.stop(), { stopped: false, reason: 'process-exit-timeout' });
    assert.equal(controller.child, child);
    assert.equal(controller.ownerId, ownerId);
    assert.equal(controller.store.read()?.ownerId, ownerId);
    const disposed = await controller.dispose({ stopOwned: true });
    assert.equal(disposed.disposed, false);
    assert.equal(disposed.reason, 'process-exit-timeout');
    assert.equal(controller.disposed, false);

    child.exitCode = 0;
    child.emit('exit', 0, 'SIGKILL');
    child.emit('close', 0, 'SIGKILL');
    await waitFor(() => controller.ownerId === '' && controller.store.read() === null);
    assert.deepEqual(await controller.dispose({ stopOwned: false }), { disposed: true });
  } finally {
    if (!controller.disposed) {
      child.exitCode = 0;
      child.emit('exit', 0, 'SIGKILL');
      child.emit('close', 0, 'SIGKILL');
      await controller.dispose({ stopOwned: false }).catch(() => {});
    }
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('auto-restart re-evaluates provider settings after backoff', async () => {
  const stateDirectory = tempState();
  let settings = { ...quickSettings(), autoRestart: true, maxRestarts: 3 };
  const children = [];
  let spawnCount = 0;
  const childProcess = {
    spawn() {
      spawnCount += 1;
      const child = new FakeChild();
      children.push(child);
      setTimeout(() => child.stdout.write(`Ready https://restart-${spawnCount}.trycloudflare.com\nRegistered tunnel connection\n`), 25);
      return child;
    },
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: () => settings,
    childProcess,
    readyTimeoutMs: 2000
  });
  try {
    assert.equal((await controller.start(8787)).provider, undefined);
    assert.equal(spawnCount, 1);
    settings = { ...externalSettings('https://switched.example.test'), autoRestart: true, maxRestarts: 3 };
    const first = children[0];
    first.exitCode = 1;
    first.emit('exit', 1, null);
    first.emit('close', 1, null);

    await waitFor(() => {
      const record = controller.store.read();
      return record?.provider === 'external' && record.publicUrl === 'https://switched.example.test';
    });
    const record = controller.store.read();
    assert.equal(record.configurationKey, configurationKey(settings, 8787));
    assert.equal(spawnCount, 1);
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

test('followers attach when only host-local provider execution settings differ', async () => {
  const stateDirectory = tempState();
  const publicUrl = 'https://shared.example.test';
  const firstSettings = {
    ...externalSettings(publicUrl),
    ngrokCommandPath: 'C:\\Tools\\owner-ngrok.exe',
    cloudflareCommandPath: 'C:\\Tools\\owner-cloudflared.exe'
  };
  const followerSettings = {
    ...externalSettings(publicUrl),
    autoRestart: true,
    maxRestarts: 10,
    ngrokCommandPath: '',
    cloudflareCommandPath: ''
  };
  const first = new TunnelController({ stateDirectory, settings: () => firstSettings, hostId: 'first' });
  const follower = new TunnelController({ stateDirectory, settings: () => followerSettings, hostId: 'follower' });
  try {
    const owner = await first.start(8787);
    const attached = await follower.start(8787);
    assert.equal(owner.owned, true);
    assert.equal(attached.attached, true);
    assert.equal(attached.publicUrl, publicUrl);
    assert.notEqual(configurationKey(firstSettings, 8787), configurationKey(followerSettings, 8787));
  } finally {
    await first.dispose({ stopOwned: true }).catch(() => {});
    await follower.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('ngrok machine mode preserves NGROK_AUTHTOKEN and surfaces a redacted authentication failure', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild();
  const token = 'machine-token-abcdefghijklmnopqrstuvwxyz';
  const previous = process.env.NGROK_AUTHTOKEN;
  const logs = [];
  let spawnedToken = '';
  process.env.NGROK_AUTHTOKEN = token;
  const childProcess = {
    spawn(command, args, options) {
      spawnedToken = String(options?.env?.NGROK_AUTHTOKEN || '');
      child.stderr.write(`ERROR: authentication failed ERR_NGROK_107 Your authtoken: ${token}\n`);
      child.exitCode = 1;
      queueMicrotask(() => {
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      });
      return child;
    },
    spawnSync(command, args) {
      if (args[0] === 'version') return { status: 0, stdout: 'ngrok version 3.37.6\n', stderr: '', error: null };
      if (args[0] === 'config' && args[1] === 'check') {
        return { status: 0, stdout: 'Valid configuration file at C:\\Users\\test\\AppData\\Local\\ngrok\\ngrok.yml\n', stderr: '', error: null };
      }
      throw new Error(`Unexpected ngrok preflight: ${args.join(' ')}`);
    }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: () => ({
      provider: 'ngrok',
      ngrokUseManagedAccount: false,
      ngrokUrl: 'https://devmate-test.ngrok-free.app',
      autoRestart: false,
      maxRestarts: 0
    }),
    getSecrets: async () => ({}),
    childProcess,
    logger: message => logs.push(String(message)),
    readyTimeoutMs: 1500
  });
  try {
    await assert.rejects(controller.start(8787), error => {
      assert.equal(error?.code, 'DEVMATE_NGROK_AUTHENTICATION');
      assert.match(error.message, /ERR_NGROK_107/);
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.doesNotMatch(String(error.providerOutput || ''), new RegExp(token));
      return true;
    });
    assert.equal(spawnedToken, token);
    assert.equal(logs.some(line => line.includes(token)), false);
    assert.doesNotMatch(controller.childOutput(child), new RegExp(token));
  } finally {
    if (previous === undefined) delete process.env.NGROK_AUTHTOKEN;
    else process.env.NGROK_AUTHTOKEN = previous;
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('ngrok before 3.30 fails before launch instead of timing out on the current endpoint API', async () => {
  const stateDirectory = tempState();
  let spawnCount = 0;
  const childProcess = {
    spawn() { spawnCount += 1; return new FakeChild(); },
    spawnSync(command, args) {
      if (args[0] === 'version') return { status: 0, stdout: 'ngrok version 3.29.0\n', stderr: '', error: null };
      throw new Error(`Unexpected ngrok preflight: ${args.join(' ')}`);
    }
  };
  const controller = new TunnelController({
    stateDirectory,
    settings: () => ({ provider: 'ngrok', ngrokUseManagedAccount: false, autoRestart: false, maxRestarts: 0 }),
    getSecrets: async () => ({}),
    childProcess
  });
  try {
    await assert.rejects(
      controller.start(8787),
      error => error?.code === 'DEVMATE_NGROK_VERSION_UNSUPPORTED' && /3\.30\.0\+/.test(error.message)
    );
    assert.equal(spawnCount, 0);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
