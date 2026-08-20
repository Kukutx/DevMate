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
  startRuntimeMaintenance,
  stopRuntimeMaintenance
} = await import('../gateway/runtime-maintenance.mjs');

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

    const second = await runRuntimeMaintenanceOnce();
    assert.equal(second.skipped, true);
    assert.equal(second.reason, 'within-bounds');
  } finally {
    stopRuntimeMaintenance();
  }
});

test.after(async () => {
  stopRuntimeMaintenance();
  await fsp.rm(root, { recursive: true, force: true });
});
