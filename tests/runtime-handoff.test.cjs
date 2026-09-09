'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  DETACHED_DESKTOP_LAUNCH_MODE,
  RuntimeController,
  desktopSpawn
} = require('../host/runtime-controller.js');
const { DesktopTunnelController } = require('../vscode-host/desktop-tunnel-controller.js');

function fakeChild(pid = 43210) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  child.killed = false;
  child.disconnectCalls = 0;
  child.unrefCalls = 0;
  child.killCalls = 0;
  child.disconnect = () => { child.disconnectCalls += 1; child.connected = false; child.emit('disconnect'); };
  child.unref = () => { child.unrefCalls += 1; };
  child.kill = () => { child.killCalls += 1; child.killed = true; };
  return child;
}

test('desktop Gateway spawn is OS-detached and marks lifecycle-owned launch mode', () => {
  let captured = null;
  const child = fakeChild();
  const spawn = desktopSpawn((command, args, options) => {
    captured = { command, args, options };
    return child;
  });
  const result = spawn('node', ['gateway.mjs'], { env: { EXISTING: '1' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  assert.equal(result, child);
  assert.equal(result.devMateDesktopDetached, true);
  assert.equal(captured.options.detached, true);
  assert.equal(captured.options.env.EXISTING, '1');
  assert.equal(captured.options.env.DEVMATE_RUNTIME_LAUNCH_MODE, DETACHED_DESKTOP_LAUNCH_MODE);
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
});

test('Gateway preserve-session dispose disconnects and unreferences without killing the child', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-gateway-handoff-'));
  const gatewayEntry = path.join(root, 'gateway.mjs');
  fs.writeFileSync(gatewayEntry, '// fake gateway\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: path.join(root, '.state'),
    gatewayEntry,
    spawnImpl: () => fakeChild()
  });
  const child = fakeChild(43211);
  controller.child = child;
  controller.owned = true;
  controller.phase = 'running';

  const result = await controller.dispose({ stopOwned: false });
  assert.equal(result.disposed, true);
  assert.equal(result.detached, true);
  assert.equal(child.disconnectCalls, 1);
  assert.equal(child.unrefCalls, 1);
  assert.equal(child.killCalls, 0);
  assert.equal(controller.child, null);
  assert.equal(controller.owned, false);
  assert.equal(controller.disposed, true);
});

test('tunnel handoff requires supervisor ACK and persisted supervisor ownership before detaching', async t => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-handoff-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const controller = new DesktopTunnelController({
    stateDirectory,
    settings: () => ({ provider: 'ngrok', autoRestart: false, maxRestarts: 0 }),
    childProcess: { spawn() { throw new Error('not used'); }, spawnSync() { return { status: 0, stdout: 'ngrok version 3.0.0' }; } },
    lifecycleWatchMs: 100
  });
  const child = fakeChild(43212);
  child.devMateSupervised = true;
  child.devMateHandoffCapable = true;
  const record = {
    ownerId: 'owner-1',
    hostPid: process.pid,
    childPid: child.pid,
    childKind: 'supervisor',
    publicUrl: 'https://example.ngrok.app'
  };
  controller.store = {
    read() { return { ...record }; },
    remove() { return false; }
  };
  controller.ownerId = record.ownerId;
  controller.port = 8787;
  controller.child = child;
  controller.childReady = true;
  child.send = (message, callback) => {
    callback?.(null);
    if (message?.type !== 'devmate:provider-handoff') return;
    record.hostPid = child.pid;
    setImmediate(() => child.emit('message', {
      type: 'devmate:provider-handoff-ready',
      ownerId: record.ownerId,
      pid: child.pid
    }));
  };

  const result = await controller.dispose({ stopOwned: false });
  assert.equal(result.disposed, true);
  assert.equal(result.detached, true);
  assert.equal(child.disconnectCalls, 1);
  assert.equal(child.unrefCalls, 1);
  assert.equal(child.killCalls, 0);
  assert.equal(controller.child, null);
  assert.equal(controller.ownerId, '');
  assert.equal(controller.disposed, true);
});

test('tunnel handoff fails closed when supervisor ownership cannot be confirmed', async t => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tunnel-handoff-fail-'));
  t.after(() => fs.rmSync(stateDirectory, { recursive: true, force: true }));
  const controller = new DesktopTunnelController({
    stateDirectory,
    settings: () => ({ provider: 'ngrok', autoRestart: false, maxRestarts: 0 }),
    childProcess: { spawn() { throw new Error('not used'); }, spawnSync() { return { status: 0, stdout: 'ngrok version 3.0.0' }; } }
  });
  const child = fakeChild(43213);
  child.devMateSupervised = true;
  child.devMateHandoffCapable = true;
  controller.ownerId = 'owner-2';
  controller.port = 8787;
  controller.child = child;
  controller.store = {
    read() { return { ownerId: 'owner-2', hostPid: process.pid, childPid: child.pid, childKind: 'supervisor' }; },
    write() { return null; },
    remove() { return false; }
  };
  child.send = (_message, callback) => callback?.(new Error('ipc unavailable'));

  const result = await controller.dispose({ stopOwned: false });
  assert.equal(result.disposed, false);
  assert.equal(result.reason, 'supervisor-handoff-unconfirmed');
  assert.equal(child.killCalls, 0);
  assert.equal(child.disconnectCalls, 0);
  assert.equal(controller.child, child);
  assert.equal(controller.disposed, false);
  controller.stopHeartbeat();
  controller.child = null;
  controller.clearLocalOwnership('owner-2');
});
