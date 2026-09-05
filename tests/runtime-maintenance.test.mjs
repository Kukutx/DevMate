import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runtime-maintenance-'));
const workspace = path.join(root, 'workspace');
const stateRoot = path.join(root, 'state');
const backupRoot = path.join(stateRoot, 'backups');
const auditLog = path.join(stateRoot, 'audit.jsonl');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
await fsp.mkdir(backupRoot, { recursive: true });

const config = configStore.newInstanceConfig({ workspaceRoot: workspace, port: 8787, appVersion: configStore.DEFAULT_VERSION });
config.jobs.embeddedRunnerEnabled = false;
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'App', role: 'active' };
config.maintenance = {
  backupRetentionDays: 30,
  auditRetentionDays: 30,
  maxBackupBytes: 1024 * 1024,
  maxAuditBytes: 256 * 1024
};
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const store = await import('../gateway/backup-store.mjs');
const {
  runRuntimeMaintenanceOnce,
  runtimeMaintenanceStatus,
  startRuntimeMaintenance,
  stopRuntimeMaintenance
} = await import('../gateway/runtime-maintenance.mjs');
const { sharedHttpRequestConcurrency } = await import('../gateway/request-concurrency.mjs');
const workspaceDescriptor = { id: 'app', name: 'App', root: workspace };

async function createSnapshot(name, bytes, maxBackupBytes = 2 * 1024 * 1024) {
  const file = path.join(workspace, name);
  await fsp.writeFile(file, Buffer.alloc(bytes, 1));
  const snapshot = await store.createBackupSnapshot({
    workspace: workspaceDescriptor,
    action: 'delete_file',
    entries: [{ role: 'target-before', originalPath: name, sourcePath: file }],
    maxBackupBytes
  });
  await store.completeBackupSnapshot(snapshot.id);
  return { id: snapshot.id, setRoot: path.join(backupRoot, snapshot.id) };
}

test('runtime maintenance trims audit high-water and indexed backup state only while idle', async () => {
  await store.initializeBackupStore({ purgeLegacy: true });
  const auditLines = Array.from({ length: 2200 }, (_, index) => JSON.stringify({
    time: new Date().toISOString(), index, action: 'tool_call', payload: 'x'.repeat(180)
  }));
  await fsp.writeFile(auditLog, `${auditLines.join('\n')}\n`, 'utf8');
  const oldest = await createSnapshot('old.bin', 700 * 1024);
  await new Promise(resolve => setTimeout(resolve, 5));
  const newest = await createSnapshot('new.bin', 700 * 1024, 3 * 1024 * 1024);
  assert.equal((await store.backupStoreStatus()).backupSets, 2);
  const healthFile = path.join(stateRoot, 'runtime-maintenance.json');
  await fsp.writeFile(healthFile, '{"version":1,"status":"degraded"}\n', 'utf8');

  startRuntimeMaintenance({
    paths: { stateRoot, backupRoot, auditLog, configFile: configPath },
    options: config.maintenance,
    intervalMs: 60_000
  });
  try {
    const first = await runRuntimeMaintenanceOnce({ force: true });
    assert.equal(first.skipped, false);
    assert(first.audit.afterBytes <= config.maintenance.maxAuditBytes);
    assert(first.audit.removedEntries > 0);
    assert(first.backups.afterBytes <= config.maintenance.maxBackupBytes);
    assert.equal(first.backups.afterSets, 1);
    await assert.rejects(fsp.stat(oldest.setRoot));
    await fsp.stat(newest.setRoot);
    await assert.rejects(fsp.stat(healthFile), 'successful maintenance clears stale degraded marker');

    const second = await runRuntimeMaintenanceOnce();
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'within-bounds');
  } finally {
    stopRuntimeMaintenance();
  }
});

test('runtime maintenance skips retention work while an HTTP request is active', async () => {
  startRuntimeMaintenance({
    paths: { stateRoot, backupRoot, auditLog, configFile: configPath },
    options: config.maintenance,
    intervalMs: 60_000
  });
  const request = sharedHttpRequestConcurrency.enter('maintenance-busy-test', 4, 4);
  assert.equal(request.allowed, true);
  try {
    const result = await runRuntimeMaintenanceOnce();
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'busy');
  } finally {
    request.release();
    stopRuntimeMaintenance();
  }
});

test('runtime maintenance fences stale completion when scheduler paths are reconfigured', async () => {
  const oldState = path.join(root, 'old-generation');
  const newState = path.join(root, 'new-generation');
  await fsp.mkdir(oldState, { recursive: true });
  await fsp.mkdir(newState, { recursive: true });
  startRuntimeMaintenance({
    paths: { stateRoot: oldState, backupRoot: path.join(oldState, 'backups'), auditLog: path.join(oldState, 'audit.jsonl'), configFile: path.join(root, 'old-config.json') },
    options: config.maintenance,
    intervalMs: 60_000
  });
  const oldRun = runRuntimeMaintenanceOnce({ force: true });
  const newStart = startRuntimeMaintenance({
    paths: { stateRoot: newState, backupRoot: path.join(newState, 'backups'), auditLog: path.join(newState, 'audit.jsonl'), configFile: path.join(root, 'new-config.json') },
    options: config.maintenance,
    intervalMs: 60_000
  });
  const newRun = runRuntimeMaintenanceOnce({ force: true });
  try {
    const [oldResult, newResult] = await Promise.all([oldRun, newRun]);
    assert.equal(oldResult.skipped, false);
    assert.equal(newResult.skipped, false);
    const status = runtimeMaintenanceStatus();
    assert.equal(status.generation, newStart.generation);
    assert.deepEqual(status.lastResult, newResult, 'stale completion must not overwrite current generation status');
  } finally {
    stopRuntimeMaintenance();
  }
});

test('runtime maintenance refuses paths that could escape its state boundary', () => {
  assert.throws(() => startRuntimeMaintenance({ paths: {} }), /stateRoot is required/);
  assert.throws(
    () => startRuntimeMaintenance({ paths: { stateRoot: path.parse(root).root } }),
    /cannot be a filesystem root/
  );
  assert.throws(
    () => startRuntimeMaintenance({ paths: { stateRoot, backupRoot: path.join(root, 'outside-backups'), auditLog, configFile: configPath } }),
    /backupRoot must be inside stateRoot/
  );
  assert.throws(
    () => startRuntimeMaintenance({ paths: { stateRoot, backupRoot, auditLog: path.join(root, 'outside-audit.jsonl'), configFile: configPath } }),
    /auditLog must be inside stateRoot/
  );
});

test.after(async () => {
  stopRuntimeMaintenance();
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(root, { recursive: true, force: true });
});
