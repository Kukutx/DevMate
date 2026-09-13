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
  UNCLAIMED_RUNTIME_VERSION,
  ensureInstanceConfig,
  healthMatches,
  readJson,
  recoverStaleGatewayProcess,
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

function writeTestGateway(root, { startupDelayMs = 0, neverListen = false, exitOnConfigVersionChange = false } = {}) {
  const gateway = path.join(root, `test-gateway-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(gateway, `
import fs from 'node:fs';
import http from 'node:http';
const config = JSON.parse(fs.readFileSync(process.env.DEVMATE_CONFIG, 'utf8'));
const startupVersion = config.appVersion;
const server = http.createServer((request, response) => {
  if (request.url === '/control/health') {
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({name:'devmate', version:config.appVersion, instanceId:config.instanceId, port:config.server.port}));
    return;
  }
  response.writeHead(404); response.end();
});
const delay = ${Number(startupDelayMs) || 0};
const neverListen = ${neverListen ? 'true' : 'false'};
const exitOnConfigVersionChange = ${exitOnConfigVersionChange ? 'true' : 'false'};
if (!neverListen) setTimeout(() => server.listen(config.server.port, '127.0.0.1'), delay);
function stop(){
  if (!server.listening) process.exit(0);
  server.close(() => process.exit(0));
}
if (exitOnConfigVersionChange) {
  const watcher = setInterval(() => {
    try {
      const current = JSON.parse(fs.readFileSync(process.env.DEVMATE_CONFIG, 'utf8'));
      if (current.appVersion !== startupVersion) stop();
    } catch {}
  }, 50);
  watcher.unref();
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

test('passive desktop initialization leaves runtime version unclaimed until Start owns the lease', async () => {
  const root = temporaryDirectory('devmate-passive-version-root-');
  const state = temporaryDirectory('devmate-passive-version-state-');
  const port = await freePort();
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root),
    preferredPort: port,
    appVersion: '3.8.7',
    hostId: 'passive-host'
  });

  const passive = controller.ensureConfig();
  assert.equal(passive.appVersion, UNCLAIMED_RUNTIME_VERSION);
  assert.equal(passive.server.port, port);

  const started = await controller.start({ timeoutMs: 5000 });
  assert.equal(started.started, true);
  assert.equal(started.port, port);
  assert.equal(readJson(controller.configFile).appVersion, '3.8.7');
  assert.equal((await controller.stop()).stopped, true);
});

test('newer desktop host upgrades the previous Gateway on the same fixed port only after Start owns the lease', async () => {
  const root = temporaryDirectory('devmate-version-handoff-root-');
  const state = temporaryDirectory('devmate-version-handoff-state-');
  const port = await freePort();
  const gateway = writeTestGateway(root, { exitOnConfigVersionChange: true });
  const oldHost = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    appVersion: '3.8.6',
    hostId: 'old-host'
  });
  const first = await oldHost.start({ timeoutMs: 5000 });
  assert.equal(first.started, true);
  assert.equal(first.port, port);
  assert.equal(readJson(oldHost.configFile).appVersion, '3.8.6');

  const newHost = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port + 1,
    appVersion: '3.8.7',
    hostId: 'new-host'
  });
  const passive = newHost.ensureConfig();
  assert.equal(passive.appVersion, '3.8.6');
  assert.equal(passive.server.port, port);
  assert.equal((await oldHost.status()).state, 'running');

  const upgraded = await newHost.start({ timeoutMs: 7000 });
  assert.equal(upgraded.started, true);
  assert.equal(upgraded.port, port);
  assert.equal(readJson(newHost.configFile).appVersion, '3.8.7');
  assert.equal(readJson(newHost.configFile).server.port, port);
  assert.equal((await oldHost.status()).state, 'running');
  assert.equal((await newHost.stop()).stopped, true);
});

test('mixed-version desktop hosts starting together converge on the newer Gateway and one fixed port', async t => {
  const root = temporaryDirectory('devmate-mixed-version-root-');
  const state = temporaryDirectory('devmate-mixed-version-state-');
  const port = await freePort();
  const gateway = writeTestGateway(root, { startupDelayMs: 100, exitOnConfigVersionChange: true });
  const oldLogs = [];
  const newLogs = [];
  const oldHost = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    appVersion: '3.8.6',
    hostId: 'vscode-old',
    logger: message => oldLogs.push(String(message))
  });
  const newHost = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    appVersion: '3.8.7',
    hostId: 'obsidian-new',
    logger: message => newLogs.push(String(message))
  });
  t.after(async () => {
    await newHost.stop().catch(() => null);
    await oldHost.stop().catch(() => null);
  });

  const [oldSettled, newSettled] = await Promise.allSettled([
    oldHost.start({ timeoutMs: 9000 }),
    newHost.start({ timeoutMs: 9000 })
  ]);
  const finalConfig = readJson(newHost.configFile);
  assert.equal(oldSettled.status, 'fulfilled', JSON.stringify({
    error: oldSettled.reason?.stack || oldSettled.reason?.message || String(oldSettled.reason || 'old host failed'),
    oldLogs,
    newLogs,
    finalConfig,
    newResult: newSettled.status === 'fulfilled' ? newSettled.value : null
  }, null, 2));
  assert.equal(newSettled.status, 'fulfilled', JSON.stringify({
    error: newSettled.reason?.stack || newSettled.reason?.message || String(newSettled.reason || 'new host failed'),
    oldLogs,
    newLogs,
    finalConfig
  }, null, 2));
  const oldResult = oldSettled.value;
  const newResult = newSettled.value;
  assert.equal(oldResult.port, port);
  assert.equal(newResult.port, port);
  assert.equal(newResult.started, true);
  const config = readJson(newHost.configFile);
  assert.equal(config.appVersion, '3.8.7');
  assert.equal(config.server.port, port);
  assert.equal((await newHost.status()).state, 'running');
  assert.equal((await oldHost.status()).state, 'running');
});

test('stale host cannot hold the startup lease while a current host is ready to start', async t => {
  const root = temporaryDirectory('devmate-stale-lease-root-');
  const state = temporaryDirectory('devmate-stale-lease-state-');
  const port = await freePort();
  const gateway = writeTestGateway(root);
  ensureInstanceConfig({
    configFile: path.join(state, 'config.json'),
    workspaceRoot: root,
    preferredPort: port,
    appVersion: '3.8.7'
  });
  const oldHost = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    appVersion: '3.8.6',
    hostId: 'stale-host'
  });
  const currentHost = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: port,
    appVersion: '3.8.7',
    hostId: 'current-host'
  });
  t.after(async () => {
    await currentHost.stop().catch(() => null);
    await oldHost.stop().catch(() => null);
  });

  const startedAt = Date.now();
  const [stale, current] = await Promise.allSettled([
    oldHost.start({ timeoutMs: 6000 }),
    currentHost.start({ timeoutMs: 6000 })
  ]);
  assert.equal(current.status, 'fulfilled', current.reason?.stack || current.reason?.message);
  assert.equal(current.value.port, port);
  assert.ok(Date.now() - startedAt < 4000, 'stale host held the shared startup lease too long');
  if (stale.status === 'rejected') {
    assert.equal(stale.reason?.code, 'DEVMATE_HOST_VERSION_STALE');
  } else {
    assert.equal(stale.value.attached, true);
    assert.equal(stale.value.port, port);
  }
});

test('older desktop host cannot downgrade shared version or spawn a stale Gateway', async () => {
  const root = temporaryDirectory('devmate-stale-host-root-');
  const state = temporaryDirectory('devmate-stale-host-state-');
  const port = await freePort();
  const configFile = path.join(state, 'config.json');
  ensureInstanceConfig({ configFile, workspaceRoot: root, preferredPort: port, appVersion: '3.8.7' });
  let spawnCalls = 0;
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root),
    preferredPort: port,
    appVersion: '3.8.6',
    spawnImpl() {
      spawnCalls += 1;
      throw new Error('stale host must not spawn');
    }
  });

  await assert.rejects(
    controller.start({ timeoutMs: 2500 }),
    error => error?.code === 'DEVMATE_HOST_VERSION_STALE' && error.requiredVersion === '3.8.7'
  );
  assert.equal(spawnCalls, 0);
  assert.equal(readJson(configFile).appVersion, '3.8.7');
});

test('Gateway health rejects stale DevMate versions even when instance identity matches', () => {
  const config = { appVersion: '3.3.0', instanceId: 'same-instance' };
  assert.equal(healthMatches({ ok: true, json: { name: 'devmate', version: '3.2.0', instanceId: 'same-instance' } }, config), false);
  assert.equal(healthMatches({ ok: true, json: { name: 'devmate', version: '3.3.0', instanceId: 'same-instance' } }, config), true);
});

test('stale same-instance Gateway recovery requires live lock and loopback identity before terminating a PID', async () => {
  const root = temporaryDirectory('devmate-stale-recovery-root-');
  const state = temporaryDirectory('devmate-stale-recovery-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: path.join(root, 'missing-gateway.mjs'),
    preferredPort: 8787,
    appVersion: '3.8.6'
  });
  const config = controller.ensureConfig();
  const health = {
    ok: true,
    json: {
      name: 'devmate',
      version: '3.8.5',
      instanceId: config.instanceId,
      port: 8787,
      configPath: controller.configFile,
      pid: 4242,
      runtimeOwnerId: 'old-owner'
    }
  };
  let terminatedPid = null;
  const terminatePid = async pid => {
    terminatedPid = pid;
    return { stopped: true, exitConfirmed: true, forced: false };
  };

  const currentVersion = await recoverStaleGatewayProcess({
    stateDirectory: state,
    configFile: controller.configFile,
    config,
    health: { ...health, json: { ...health.json, version: config.appVersion } },
    terminatePid,
    pidIsRunning: () => true,
    probeHealth: async () => health
  });
  assert.equal(currentVersion.recovered, false);
  assert.equal(currentVersion.reason, 'not-stale-version');
  assert.equal(terminatedPid, null);

  const blocked = await recoverStaleGatewayProcess({
    stateDirectory: state,
    configFile: controller.configFile,
    config,
    health,
    terminatePid,
    pidIsRunning: () => true,
    probeHealth: async () => health
  });
  assert.equal(blocked.recovered, false);
  assert.equal(blocked.reason, 'ownership-not-proven');
  assert.equal(terminatedPid, null);

  const lockDirectory = path.join(state, 'state');
  const lockPath = path.join(lockDirectory, 'gateway.lock');
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.mkdirSync(lockDirectory, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    version: 2,
    pid: 4242,
    runtimeOwnerId: 'old-owner',
    instanceId: config.instanceId,
    configPath: controller.configFile,
    acquiredAt: old.toISOString(),
    heartbeatAt: old.toISOString(),
    leaseMs: 1200000
  }, null, 2)}\n`, 'utf8');

  const unavailable = await recoverStaleGatewayProcess({
    stateDirectory: state,
    configFile: controller.configFile,
    config,
    health: { ok: false, error: 'ECONNREFUSED' },
    terminatePid,
    pidIsRunning: () => true,
    probeHealth: async () => health
  });
  assert.equal(unavailable.recovered, false);
  assert.equal(terminatedPid, null);

  fs.utimesSync(lockPath, old, old);
  const staleLock = await recoverStaleGatewayProcess({
    stateDirectory: state,
    configFile: controller.configFile,
    config,
    health,
    terminatePid,
    pidIsRunning: () => true,
    probeHealth: async () => health
  });
  assert.equal(staleLock.recovered, false);
  assert.equal(staleLock.reason, 'ownership-not-proven');
  assert.equal(terminatedPid, null);

  const current = new Date();
  fs.utimesSync(lockPath, current, current);
  const identityChanged = await recoverStaleGatewayProcess({
    stateDirectory: state,
    configFile: controller.configFile,
    config,
    health,
    terminatePid: async pid => {
      terminatedPid = pid;
      return { stopped: false, exitConfirmed: false, forced: false, reason: 'identity-changed' };
    },
    pidIsRunning: () => true,
    probeHealth: async () => health
  });
  assert.equal(identityChanged.recovered, false);
  assert.equal(identityChanged.reason, 'identity-changed');
  assert.equal(fs.existsSync(lockPath), true);

  const recovered = await recoverStaleGatewayProcess({
    stateDirectory: state,
    configFile: controller.configFile,
    config,
    health,
    terminatePid,
    pidIsRunning: () => true,
    probeHealth: async () => health
  });
  assert.equal(recovered.recovered, true);
  assert.equal(terminatedPid, 4242);
  assert.equal(fs.existsSync(lockPath), false);
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

test('runtime controller clears only its own host context on a clean host shutdown', () => {
  const root = temporaryDirectory('devmate-context-clear-root-');
  const state = temporaryDirectory('devmate-context-clear-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: path.join(root, 'missing-gateway.mjs'),
    hostId: 'vscode-project-123'
  });
  controller.ensureConfig();
  controller.updateHostContext({ kind: 'editor', updatedAt: '2026-01-01T00:00:00.000Z' });
  const other = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: path.join(root, 'missing-gateway.mjs'),
    hostId: 'obsidian-vault-456'
  });
  other.updateHostContext({ kind: 'knowledge-base', updatedAt: '2026-01-01T00:01:00.000Z' });

  controller.clearHostContext();
  const config = readJson(controller.configFile);
  assert.equal(config.hostContexts['vscode-project-123'], undefined);
  assert.equal(config.hostContexts['obsidian-vault-456'].kind, 'knowledge-base');
  assert.equal(config.activeHostId, 'obsidian-vault-456');
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

test('dispose always releases an owned Gateway before disposing the controller', async () => {
  const root = temporaryDirectory('devmate-dispose-root-');
  const state = temporaryDirectory('devmate-dispose-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: writeTestGateway(root),
    preferredPort: await freePort()
  });
  await controller.start({ timeoutMs: 5000 });
  const disposed = await controller.dispose();
  assert.equal(disposed.disposed, true);
  assert.equal(disposed.stop.stopped, true);
  assert.equal(controller.disposed, true);
  assert.equal(controller.owned, false);
  assert.equal(controller.child, null);
  assert.equal(controller.phase, 'disposed');
});
