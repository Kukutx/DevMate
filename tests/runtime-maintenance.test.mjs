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
config.maintenance = {
  backupRetentionDays: 30,
  auditRetentionDays: 30,
  maxBackupBytes: 1024 * 1024,
  maxAuditBytes: 256 * 1024
};
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const {
  runRuntimeMaintenanceOnce,
  runtimeMaintenanceStatus,
  startRuntimeMaintenance,
  stopRuntimeMaintenance
} = await import('../gateway/runtime-maintenance.mjs');
const { sharedHttpRequestConcurrency } = await import('../gateway/request-concurrency.mjs');

test('runtime maintenance trims audit high-water and changed backup state only while idle', async () => {
  const auditLines = Array.from({ length: 2200 }, (_, index) => JSON.stringify({
    time: new Date().toISOString(),
    index,
    action: 'tool_call',
    payload: 'x'.repeat(180)
  }));
  await fsp.writeFile(auditLog, `${auditLines.join('\n')}\n`, 'utf8');

  const oldest = path.join(backupRoot, '2026-08-20T00-00-00-000Z-old');
  const newest = path.join(backupRoot, '2026-08-20T00-00-01-000Z-new');
  await fsp.mkdir(oldest, { recursive: true });
  await fsp.mkdir(newest, { recursive: true });
  await fsp.writeFile(path.join(oldest, 'snapshot.bin'), Buffer.alloc(700 * 1024, 1));
  await fsp.writeFile(path.join(newest, 'snapshot.bin'), Buffer.alloc(700 * 1024, 2));
  const oldDate = new Date('2026-08-20T00:00:00.000Z');
  const newDate = new Date('2026-08-20T00:00:01.000Z');
  await fsp.utimes(oldest, oldDate, oldDate);
  await fsp.utimes(newest, newDate, newDate);
  const healthFile = path.join(stateRoot, 'runtime-maintenance.json');
  await fsp.writeFile(healthFile, '{"version":1,"status":"degraded"}\n', 'utf8');

  startRuntimeMaintenance({
    paths: { stateRoot, backupRoot, auditLog },
    options: config.maintenance,
    intervalMs: 60_000
  });

  try {
    const first = await runRuntimeMaintenanceOnce();
    assert.equal(first.skipped, false);
    assert(first.audit.afterBytes <= config.maintenance.maxAuditBytes);
    assert(first.audit.removedEntries > 0);
    assert(first.backups.afterBytes <= config.maintenance.maxBackupBytes);
    assert.equal(first.backups.afterSets, 1);
    await assert.rejects(fsp.stat(oldest));
    await fsp.stat(newest);
    await assert.rejects(fsp.stat(healthFile), 'a successful maintenance check must clear a marker from a previous process');

    const second = await runRuntimeMaintenanceOnce();
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'within-bounds');
  } finally {
    stopRuntimeMaintenance();
  }
});

test('runtime maintenance skips retention work while an HTTP request is active', async () => {
  startRuntimeMaintenance({
    paths: { stateRoot, backupRoot, auditLog },
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

test('runtime maintenance fences stale completion when the scheduler is reconfigured', async () => {
  const oldState = path.join(root, 'old-generation');
  const newState = path.join(root, 'new-generation');
  const oldBackups = path.join(oldState, 'backups');
  const newBackups = path.join(newState, 'backups');
  await fsp.mkdir(oldBackups, { recursive: true });
  await fsp.mkdir(newBackups, { recursive: true });
  for (const name of ['a', 'b']) {
    const set = path.join(oldBackups, name);
    await fsp.mkdir(set);
    await fsp.writeFile(path.join(set, 'snapshot.bin'), Buffer.alloc(32, 1));
  }
  const newSet = path.join(newBackups, 'current');
  await fsp.mkdir(newSet);
  await fsp.writeFile(path.join(newSet, 'snapshot.bin'), Buffer.alloc(32, 2));

  startRuntimeMaintenance({
    paths: { stateRoot: oldState, backupRoot: oldBackups, auditLog: path.join(oldState, 'audit.jsonl') },
    options: config.maintenance,
    intervalMs: 60_000
  });
  const oldRun = runRuntimeMaintenanceOnce({ force: true });

  const newStart = startRuntimeMaintenance({
    paths: { stateRoot: newState, backupRoot: newBackups, auditLog: path.join(newState, 'audit.jsonl') },
    options: config.maintenance,
    intervalMs: 60_000
  });
  const newRun = runRuntimeMaintenanceOnce({ force: true });

  try {
    const [oldResult, newResult] = await Promise.all([oldRun, newRun]);
    assert.equal(oldResult.backups.beforeSets, 2);
    assert.equal(newResult.backups.beforeSets, 1, 'a caller after reconfigure must receive the current generation result');
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
    () => startRuntimeMaintenance({ paths: { stateRoot, backupRoot: path.join(root, 'outside-backups'), auditLog } }),
    /backupRoot must be inside stateRoot/
  );
  assert.throws(
    () => startRuntimeMaintenance({ paths: { stateRoot, backupRoot, auditLog: path.join(root, 'outside-audit.jsonl') } }),
    /auditLog must be inside stateRoot/
  );
});

test.after(async () => {
  stopRuntimeMaintenance();
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(root, { recursive: true, force: true });
});
