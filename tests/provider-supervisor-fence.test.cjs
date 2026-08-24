'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { atomicWriteJsonFile } = require('../shared/atomic-json-file.cjs');
const { createSupervisedChildProcess } = require('../host/runtime/supervised-child-process.js');
const {
  SharedTunnelRecordStore,
  configurationKey
} = require('../vscode-host/shared-tunnel-record-store.js');

class FakeSupervisor extends EventEmitter {
  constructor() {
    super();
    this.pid = process.pid;
    this.connected = true;
    this.exitCode = null;
    this.signalCode = null;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.signals = [];
  }

  send(message, callback) {
    this.messages.push(message);
    callback?.(null);
    return true;
  }

  kill(signal = 'SIGTERM') {
    this.signals.push(signal);
    return true;
  }
}

test('supervised provider escalation never SIGKILLs the ownership fence', () => {
  const fake = new FakeSupervisor();
  const childProcess = {
    spawn() { return fake; },
    spawnSync() { return { status: 0, stdout: '', stderr: '' }; }
  };
  const supervised = createSupervisedChildProcess({
    childProcess,
    supervisorEntry: path.join(__dirname, '..', 'host', 'runtime', 'provider-supervisor.js')
  });
  const child = supervised.spawn('cloudflared', ['tunnel'], {});
  assert.equal(child.devMateSupervised, true);
  assert.equal(typeof child.forceTerminate, 'function');
  child.forceTerminate();
  assert.ok(child.messages.some(message => message?.type === 'devmate:provider-stop'));
  assert.ok(child.signals.includes('SIGTERM'));
  assert.equal(child.signals.includes('SIGKILL'), false);
});

test('stale host ownership remains fenced while its provider supervisor is alive', () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-supervisor-fence-'));
  const store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: 30000 });
  const settings = {
    provider: 'external',
    publicUrl: 'https://fenced.example.test',
    deploymentMode: 'production',
    autoRestart: false,
    maxRestarts: 0
  };
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const record = {
    version: 1,
    ownerId: 'dead-host-owner',
    hostId: 'dead-host',
    hostPid: 2147483647,
    childPid: process.pid,
    childKind: 'supervisor',
    port: 8787,
    provider: 'external',
    configurationKey: configurationKey(settings, 8787),
    status: 'ready',
    publicUrl: settings.publicUrl,
    acquiredAt: old,
    readyAt: old,
    heartbeatAt: old,
    leaseMs: 30000
  };
  try {
    atomicWriteJsonFile(store.recordFile, record, { maxBytes: 64 * 1024 });
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(store.recordFile, stale, stale);
    assert.throws(
      () => store.read(),
      error => error?.code === 'DEVMATE_TUNNEL_SUPERVISOR_CLEANUP_PENDING' && error.childPid === process.pid
    );
    assert.equal(fs.existsSync(store.recordFile), true, 'live supervisor ownership record must not be discarded by age');

    atomicWriteJsonFile(store.recordFile, { ...record, childPid: 2147483646 }, { maxBytes: 64 * 1024 });
    fs.utimesSync(store.recordFile, stale, stale);
    assert.equal(store.read(), null);
    assert.equal(fs.existsSync(store.recordFile), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});