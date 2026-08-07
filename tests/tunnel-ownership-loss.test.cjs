'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { TunnelController, childActive } = require('../vscode-host/tunnel-controller.js');
const { configurationKey, nowIso } = require('../vscode-host/shared-tunnel-record-store.js');

let nextPid = 98000;

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-ownership-'));
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

function externalSettings() {
  return {
    provider: 'external',
    publicUrl: 'https://external.example.test',
    deploymentMode: 'production',
    autoRestart: false,
    maxRestarts: 0
  };
}

class FakeChild extends EventEmitter {
  constructor({ stubborn = false } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = nextPid++;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.stubborn = stubborn;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.signalCode = signal;
    if (this.stubborn || this.exitCode != null) return true;
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit('exit', 0, signal);
      this.emit('close', 0, signal);
    });
    return true;
  }

  exitNow(code = 0, signal = 'SIGKILL') {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

function childProcessFor(child, url = 'https://ownership.trycloudflare.com') {
  return {
    spawnSync() { return { status: 0, stdout: 'cloudflared version', stderr: '', error: null }; },
    spawn() {
      setTimeout(() => child.stdout.write(`Ready ${url}\n`), 20);
      return child;
    }
  };
}

function otherOwnerRecord(port, settings, publicUrl = 'https://other.trycloudflare.com') {
  const timestamp = nowIso();
  return {
    version: 1,
    ownerId: 'other-host-owner',
    hostId: 'other-host',
    hostPid: process.pid,
    childPid: null,
    port,
    provider: settings.provider,
    configurationKey: configurationKey(settings, port),
    status: 'ready',
    publicUrl,
    acquiredAt: timestamp,
    heartbeatAt: timestamp,
    readyAt: timestamp,
    leaseMs: 30000
  };
}

test('ownership transfer closes the local provider and preserves the new owner record', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild();
  const settings = quickSettings();
  const controller = new TunnelController({
    stateDirectory,
    settings: () => settings,
    childProcess: childProcessFor(child),
    readyTimeoutMs: 1500,
    stopTimeoutMs: 100,
    forceStopTimeoutMs: 100
  });
  try {
    assert.equal((await controller.start(8787)).owned, true);
    const replacement = otherOwnerRecord(8787, settings);
    atomicWriteJson(controller.store.recordFile, replacement);

    const verified = await controller.verifyOwnership();
    assert.equal(verified.healthy, false);
    assert.equal(verified.cleanup.cleaned, true);
    assert.equal(child.killed, true);
    assert.equal(controller.child, null);
    assert.equal(controller.ownerId, '');
    assert.equal(controller.store.read().ownerId, replacement.ownerId);
  } finally {
    await controller.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('a missing shared record requires two failed checks before fail-closed cleanup', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild();
  const controller = new TunnelController({
    stateDirectory,
    settings: quickSettings,
    childProcess: childProcessFor(child),
    readyTimeoutMs: 1500,
    stopTimeoutMs: 100,
    forceStopTimeoutMs: 100
  });
  try {
    assert.equal((await controller.start(8787)).owned, true);
    fs.rmSync(controller.store.recordFile, { force: true });

    const first = await controller.verifyOwnership();
    assert.equal(first.pending, true);
    assert.equal(childActive(child), true);
    assert.ok(controller.ownerId);

    const second = await controller.verifyOwnership();
    assert.equal(second.cleanup.cleaned, true);
    assert.equal(child.killed, true);
    assert.equal(controller.ownerId, '');
    assert.equal(controller.child, null);
  } finally {
    await controller.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('failed ownership-loss termination keeps the provider tracked for retry', async () => {
  const stateDirectory = tempState();
  const child = new FakeChild({ stubborn: true });
  const settings = quickSettings();
  const controller = new TunnelController({
    stateDirectory,
    settings: () => settings,
    childProcess: childProcessFor(child),
    readyTimeoutMs: 1500,
    stopTimeoutMs: 100,
    forceStopTimeoutMs: 100
  });
  try {
    assert.equal((await controller.start(8787)).owned, true);
    const ownerId = controller.ownerId;
    const replacement = otherOwnerRecord(8787, settings);
    atomicWriteJson(controller.store.recordFile, replacement);

    const verified = await controller.verifyOwnership();
    assert.equal(verified.cleanup.cleaned, false);
    assert.equal(childActive(child), true);
    assert.equal(controller.child, child);
    assert.equal(controller.ownerId, ownerId);
    assert.equal(controller.store.read().ownerId, replacement.ownerId);

    child.exitNow();
    controller.child = null;
    controller.stopHeartbeat();
    controller.clearLocalOwnership(ownerId);
  } finally {
    await controller.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('external ingress clears local ownership after repeated record loss without requiring secrets or a child process', async () => {
  const stateDirectory = tempState();
  const controller = new TunnelController({ stateDirectory, settings: externalSettings });
  try {
    assert.equal((await controller.start(8787)).owned, true);
    assert.equal(controller.child, null);
    fs.rmSync(controller.store.recordFile, { force: true });

    assert.equal((await controller.verifyOwnership()).pending, true);
    const second = await controller.verifyOwnership();
    assert.equal(second.cleanup.cleaned, true);
    assert.equal(controller.ownerId, '');
    assert.equal(controller.child, null);
  } finally {
    await controller.dispose({ stopOwned: false }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
