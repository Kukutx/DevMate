'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RuntimeController,
  ensureInstanceConfig,
  healthMatches,
  readJson,
  resolveStateDirectory,
  workspaceRuntimeId
} = require('../host/runtime-controller.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function writeTestGateway(root, { startupDelayMs = 0, neverListen = false } = {}) {
  const gateway = path.join(root, `test-gateway-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(gateway, `
import fs from 'node:fs';
import http from 'node:http';
const config = JSON.parse(fs.readFileSync(process.env.DEVMATE_CONFIG, 'utf8'));
const server = http.createServer((request, response) => {
  if (request.url === '/control/health') {
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({name:'devmate', version:config.appVersion, instanceId:config.instanceId}));
    return;
  }
  response.writeHead(404); response.end();
});
const delay = ${Number(startupDelayMs) || 0};
const neverListen = ${neverListen ? 'true' : 'false'};
if (!neverListen) setTimeout(() => server.listen(config.server.port, '127.0.0.1'), delay);
function stop(){
  if (!server.listening) process.exit(0);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
`, 'utf8');
  return gateway;
}

test('workspace runtime IDs are stable and path-specific', () => {
  const first = temporaryDirectory('devmate-runtime-id-first-');
  const second = temporaryDirectory('devmate-runtime-id-second-');
  assert.equal(workspaceRuntimeId(first), workspaceRuntimeId(first));
  assert.notEqual(workspaceRuntimeId(first), workspaceRuntimeId(second));
});

test('shared state resolves below the configured home directory', () => {
  const root = temporaryDirectory('devmate-state-root-');
  const home = temporaryDirectory('devmate-state-home-');
  const state = resolveStateDirectory({ workspaceRoot: root, homeDirectory: home });
  assert.equal(state, path.join(home, '.devmate', 'desktop'));
});

test('instance config creation preserves unrelated fields on later updates', () => {
  const root = temporaryDirectory('devmate-config-root-');
  const state = temporaryDirectory('devmate-config-state-');
  const file = path.join(state, 'config.json');
  const created = ensureInstanceConfig({ configFile: file, workspaceRoot: root, preferredPort: 9123 });
  assert.equal(created.server.port, 9123);
  assert.equal(created.workspaces[0].root, root);
  created.custom = { keep: true };
  fs.writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, 'utf8');
  const updated = ensureInstanceConfig({ configFile: file, workspaceRoot: root, preferredPort: 9999 });
  assert.deepEqual(updated.custom, { keep: true });
  assert.equal(updated.server.port, 9123);
});

test('Gateway health rejects stale DevMate versions even when instance identity matches', () => {
  const config = { appVersion: '3.3.0', instanceId: 'same-instance' };
  assert.equal(healthMatches({ ok: true, json: { name: 'devmate', version: '3.2.0', instanceId: 'same-instance' } }, config), false);
  assert.equal(healthMatches({ ok: true, json: { name: 'devmate', version: '3.3.0', instanceId: 'same-instance' } }, config), true);
});

test('runtime controller publishes a bounded generic host context', () => {
  const root = temporaryDirectory('devmate-context-root-');
  const state = temporaryDirectory('devmate-context-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: path.join(root, 'missing-gateway.mjs'),
    hostId: 'obsidian'
  });
  controller.ensureConfig();
  controller.updateHostContext({ kind: 'knowledge-base', activeDocument: { path: 'Project.md' } });
  const config = readJson(controller.configFile);
  assert.equal(config.activeHostId, 'obsidian');
  assert.equal(config.hostContexts.obsidian.activeDocument.path, 'Project.md');
  assert.equal(config.hostContexts.obsidian.workspaceRoot, root);
});

test('runtime controller reuses its owned Gateway and waits for clean stop', async () => {
  const root = temporaryDirectory('devmate-owned-root-');
  const state = temporaryDirectory('devmate-owned-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root),
    preferredPort: await freePort()
  });
  const first = await controller.start({ timeoutMs: 5000 });
  assert.equal(first.started, true);
  assert.equal(controller.owned, true);
  assert.equal(controller.phase, 'running');
  const second = await controller.start({ timeoutMs: 5000 });
  assert.equal(second.started, false);
  assert.equal(second.attached, false);
  assert.equal(second.owned, true);
  const stopped = await controller.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(controller.phase, 'idle');
  assert.equal((await controller.status()).state, 'stopped');
});

test('concurrent starts on one controller create only one owned Gateway', async () => {
  const root = temporaryDirectory('devmate-one-controller-root-');
  const state = temporaryDirectory('devmate-one-controller-state-');
  let spawnCalls = 0;
  const childProcess = require('node:child_process');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root, { startupDelayMs: 250 }),
    preferredPort: await freePort(),
    spawnImpl(...args) {
      spawnCalls += 1;
      return childProcess.spawn(...args);
    }
  });

  const [first, second, third] = await Promise.all([
    controller.start({ timeoutMs: 6000 }),
    controller.start({ timeoutMs: 6000 }),
    controller.start({ timeoutMs: 6000 })
  ]);
  assert.equal(spawnCalls, 1);
  assert.equal([first, second, third].filter(result => result.started).length, 1);
  assert.equal([first, second, third].filter(result => result.owned).length, 3);
  assert.equal(controller.diagnosticSnapshot().operation.queued, 0);
  await controller.stop();
});

test('two hosts sharing state converge on one Gateway without duplicate spawn', async () => {
  const root = temporaryDirectory('devmate-two-host-root-');
  const state = temporaryDirectory('devmate-two-host-state-');
  const gateway = writeTestGateway(root, { startupDelayMs: 300 });
  const port = await freePort();
  const childProcess = require('node:child_process');
  let spawnCalls = 0;
  const spawnImpl = (...args) => {
    spawnCalls += 1;
    return childProcess.spawn(...args);
  };
  const vscode = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    hostId: 'vscode',
    spawnImpl
  });
  const obsidian = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    hostId: 'obsidian',
    spawnImpl
  });

  const [left, right] = await Promise.all([
    vscode.start({ timeoutMs: 7000 }),
    obsidian.start({ timeoutMs: 7000 })
  ]);
  assert.equal(spawnCalls, 1);
  assert.equal([left, right].filter(result => result.started).length, 1);
  assert.equal([left, right].filter(result => result.attached).length, 1);
  const owner = left.started ? vscode : obsidian;
  const follower = left.started ? obsidian : vscode;
  assert.equal(owner.owned, true);
  assert.equal(follower.owned, false);
  assert.equal((await follower.stop()).reason, 'managed-by-another-host');
  assert.equal((await owner.stop()).stopped, true);
});

test('a stop submitted during startup runs after startup and leaves no process', async () => {
  const root = temporaryDirectory('devmate-start-stop-root-');
  const state = temporaryDirectory('devmate-start-stop-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root, { startupDelayMs: 300 }),
    preferredPort: await freePort()
  });
  const starting = controller.start({ timeoutMs: 6000 });
  const stopping = controller.stop();
  assert.equal((await starting).started, true);
  assert.equal((await stopping).stopped, true);
  assert.equal(controller.owned, false);
  assert.equal(controller.child, null);
  assert.equal((await controller.status()).state, 'stopped');
});

test('failed startup waits for process cleanup before returning an error', async () => {
  const root = temporaryDirectory('devmate-failed-start-root-');
  const state = temporaryDirectory('devmate-failed-start-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root, { neverListen: true }),
    preferredPort: await freePort()
  });
  await assert.rejects(
    controller.start({ timeoutMs: 2200 }),
    error => {
      assert.equal(error.code, 'DEVMATE_GATEWAY_START_FAILED');
      assert.equal(error.diagnostics.owned, false);
      return true;
    }
  );
  assert.equal(controller.child, null);
  assert.equal(controller.owned, false);
  assert.equal(controller.phase, 'idle');
  assert.equal(fs.existsSync(path.join(state, 'gateway.start.lock')), false);
});

class StubbornGatewayChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 987654;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill() {
    this.killed = true;
    return true;
  }
}

test('failed startup keeps ownership until a stubborn Gateway actually exits', async () => {
  const root = temporaryDirectory('devmate-stubborn-start-root-');
  const state = temporaryDirectory('devmate-stubborn-start-state-');
  const gateway = writeTestGateway(root, { neverListen: true });
  const child = new StubbornGatewayChild();
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: await freePort(),
    spawnImpl: () => child,
    childExitTimeoutMs: 100,
    childForceExitTimeoutMs: 100
  });

  await assert.rejects(
    controller.start({ timeoutMs: 2000 }),
    error => error.code === 'DEVMATE_GATEWAY_START_CLEANUP_PENDING' && error.cleanupPending === true
  );
  assert.equal(controller.child, child);
  assert.equal(controller.owned, true);
  assert.equal(controller.phase, 'stopping');

  child.exitCode = 0;
  child.emit('exit', 0, 'SIGKILL');
  child.emit('close', 0, 'SIGKILL');
  assert.equal(controller.child, null);
  assert.equal(controller.owned, false);
  assert.equal(controller.phase, 'idle');
});

test('dispose refuses to orphan an owned process unless stopOwned is requested', async () => {
  const root = temporaryDirectory('devmate-dispose-root-');
  const state = temporaryDirectory('devmate-dispose-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root),
    preferredPort: await freePort()
  });
  await controller.start({ timeoutMs: 5000 });
  const refused = await controller.dispose();
  assert.deepEqual(refused, { disposed: false, reason: 'owned-process-running' });
  assert.equal(controller.disposed, false);
  const disposed = await controller.dispose({ stopOwned: true });
  assert.equal(disposed.disposed, true);
  assert.equal(controller.disposed, true);
  assert.equal(controller.phase, 'disposed');
});
