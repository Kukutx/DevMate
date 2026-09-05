import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-backup-store-'));
const workspaceRoot = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
const backupRoot = path.join(root, 'state', 'backups');
await fsp.mkdir(workspaceRoot, { recursive: true });
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const config = configStore.newInstanceConfig({ workspaceRoot, appVersion: configStore.DEFAULT_VERSION });
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'App', role: 'active' };
config.permissions.profile = 'fullAccess';
config.maintenance.maxBackupBytes = 8 * 1024 * 1024;
configStore.atomicWriteJson(configPath, config);

const store = await import('../gateway/backup-store.mjs');
const { safeFileMutationHandler } = await import('../gateway/file-mutation-safety.mjs');
const workspace = { id: 'app', name: 'App', root: workspaceRoot };

async function exists(file) {
  return fsp.stat(file).then(() => true, () => false);
}

async function resetBackupStore() {
  await fsp.rm(backupRoot, { recursive: true, force: true });
  return store.initializeBackupStore({ purgeLegacy: true });
}

async function completeSnapshot({
  workspace: targetWorkspace = workspace,
  action = 'write_file',
  originalPath,
  sourcePath,
  bytes = null,
  maxBackupBytes = 16 * 1024 * 1024
}) {
  if (sourcePath && bytes != null) {
    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(sourcePath, Buffer.alloc(bytes, 7));
  }
  const snapshot = await store.createBackupSnapshot({
    workspace: targetWorkspace,
    action,
    entries: [{ role: 'target-before', originalPath, sourcePath }],
    maxBackupBytes
  });
  return store.completeBackupSnapshot(snapshot.id);
}

test('new backup store purges legacy layouts and commits a recoverable snapshot before mutation begins', async () => {
  await fsp.rm(backupRoot, { recursive: true, force: true });
  const legacy = path.join(backupRoot, '2025-legacy-layout', 'src');
  await fsp.mkdir(legacy, { recursive: true });
  await fsp.writeFile(path.join(legacy, 'old.js'), 'legacy', 'utf8');

  const init = await store.initializeBackupStore({ purgeLegacy: true });
  assert.equal(init.source, 'manifest-rebuild');
  assert(init.removed.some(item => item.reason === 'legacy'));
  assert.equal(await exists(path.join(backupRoot, '2025-legacy-layout')), false);

  const file = path.join(workspaceRoot, 'src', 'app.js');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'before\n', 'utf8');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fsp.utimes(file, old, old);

  const beforeCreate = Date.now();
  const prepared = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'src/app.js', sourcePath: file }],
    maxBackupBytes: config.maintenance.maxBackupBytes
  });
  assert.equal(prepared.committed, true);
  assert.equal(prepared.mutationState, 'prepared');
  assert.equal((await store.listBackups({ limit: 10 })).length, 1);

  const fast = await store.initializeBackupStore({ purgeLegacy: true });
  assert.equal(fast.source, 'index');
  assert.equal((await store.listBackups({ limit: 10 }))[0]?.id, prepared.id);

  const completed = await store.completeBackupSnapshot(prepared.id, { transactionId: 'ftx-test' });
  assert.equal(completed.mutationState, 'completed');
  assert.ok(completed.mutationCompletedAt);
  assert(Date.parse(completed.createdAt) >= beforeCreate);
  assert(Date.parse(completed.createdAt) > Date.parse('2026-01-01T00:00:00.000Z'));

  const items = await store.listBackups({ workspaceId: 'app', path: 'src/app.js', action: 'write_file' });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, completed.id);
  assert.equal(items[0].entries[0].originalPath, 'src/app.js');
  assert.equal(await exists(path.join(backupRoot, 'index.jsonl')), true);
  assert.equal(await exists(path.join(backupRoot, 'index.json')), false);
});

test('backup index is append-only during normal mutations and exposes bounded event status', async () => {
  await resetBackupStore();
  const first = path.join(workspaceRoot, 'index-first.txt');
  const second = path.join(workspaceRoot, 'index-second.txt');
  await fsp.writeFile(first, 'first\n', 'utf8');
  await fsp.writeFile(second, 'second\n', 'utf8');

  const a = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'index-first.txt', sourcePath: first }]
  });
  const afterPreparedA = await fsp.stat(path.join(backupRoot, 'index.jsonl'));
  await store.completeBackupSnapshot(a.id);
  const afterCompletedA = await fsp.stat(path.join(backupRoot, 'index.jsonl'));

  const b = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'index-second.txt', sourcePath: second }]
  });
  await store.completeBackupSnapshot(b.id);
  const afterCompletedB = await fsp.stat(path.join(backupRoot, 'index.jsonl'));
  const lines = (await fsp.readFile(path.join(backupRoot, 'index.jsonl'), 'utf8')).trim().split(/\r?\n/);

  assert(afterCompletedA.size > afterPreparedA.size);
  assert(afterCompletedB.size > afterCompletedA.size);
  assert.equal(lines.length, 5, 'header plus prepared/completed upserts for two snapshots');
  assert.deepEqual(JSON.parse(lines[0]), { version: store.BACKUP_INDEX_VERSION, type: 'header' });
  const status = await store.backupStoreStatus();
  assert.equal(status.indexEvents, 4);
  assert.equal(status.completedSnapshots, 2);
});

test('fast startup reconciles only prepared snapshot operation state without a manifest rebuild', async () => {
  await resetBackupStore();
  const file = path.join(workspaceRoot, 'reconcile.txt');
  await fsp.writeFile(file, 'before\n', 'utf8');
  const prepared = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'reconcile.txt', sourcePath: file }]
  });
  const operationFile = path.join(backupRoot, prepared.id, store.BACKUP_OPERATION_FILE);
  const operation = JSON.parse(await fsp.readFile(operationFile, 'utf8'));
  operation.mutationCompletedAt = new Date().toISOString();
  operation.transactionId = 'ftx-crash-window';
  await fsp.writeFile(operationFile, `${JSON.stringify(operation, null, 2)}\n`, 'utf8');

  const init = await store.initializeBackupStore({ purgeLegacy: true });
  assert.equal(init.source, 'index');
  const [item] = await store.listBackups({ limit: 1 });
  assert.equal(item.id, prepared.id);
  assert.equal(item.mutationState, 'completed');
  assert.equal(item.transactionId, 'ftx-crash-window');
});

test('failed snapshots remain durable but are explicitly distinguishable from crash-unknown prepared snapshots', async () => {
  await resetBackupStore();
  const file = path.join(workspaceRoot, 'failed.txt');
  await fsp.writeFile(file, 'before\n', 'utf8');
  const prepared = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'failed.txt', sourcePath: file }]
  });
  const simulated = new Error('simulated mutation failure');
  simulated.code = 'SIMULATED_FAILURE';
  const failed = await store.failBackupSnapshot(prepared.id, simulated);
  assert.equal(failed.mutationState, 'failed');
  assert.equal(failed.mutationErrorCode, 'SIMULATED_FAILURE');

  const failedItems = await store.listBackups({ mutationState: 'failed' });
  assert.deepEqual(failedItems.map(item => item.id), [prepared.id]);
  const source = await store.backupEntry(prepared.id, 'failed.txt');
  assert.equal(source.entry.kind, 'file', 'manual recovery remains possible from a failed mutation snapshot');

  await assert.rejects(
    store.completeBackupSnapshot(prepared.id),
    /already marked failed/
  );
});

test('backup store blocks protected absent paths and mismatched source/original-path pairs itself', async () => {
  await resetBackupStore();
  await assert.rejects(
    store.createBackupSnapshot({
      workspace,
      action: 'create_file',
      entries: [{ role: 'target-before', originalPath: '.env', sourcePath: null }]
    }),
    error => error?.code === 'sensitive_workspace_path'
  );

  const actual = path.join(workspaceRoot, 'mapping-source.txt');
  await fsp.writeFile(actual, 'source\n', 'utf8');
  await assert.rejects(
    store.createBackupSnapshot({
      workspace,
      action: 'write_file',
      entries: [{ role: 'target-before', originalPath: 'different-name.txt', sourcePath: actual }]
    }),
    error => error?.code === 'backup_source_path_mismatch'
  );
});

test('backup payload integrity and sensitive descendants are verified before restore access', async () => {
  await resetBackupStore();
  const file = path.join(workspaceRoot, 'integrity.txt');
  await fsp.writeFile(file, 'before\n', 'utf8');
  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'integrity.txt', sourcePath: file }]
  });
  await store.completeBackupSnapshot(snapshot.id);
  const source = await store.backupEntry(snapshot.id, 'integrity.txt');
  await fsp.writeFile(source.payloadPath, 'tampered\n', 'utf8');
  await assert.rejects(
    store.backupEntry(snapshot.id, 'integrity.txt'),
    error => error?.code === 'backup_integrity_failed'
  );

  const protectedTree = path.join(workspaceRoot, 'protected-tree');
  await fsp.mkdir(path.join(protectedTree, '.ssh'), { recursive: true });
  await fsp.writeFile(path.join(protectedTree, '.ssh', 'id_ed25519'), 'private\n', 'utf8');
  await assert.rejects(
    store.createBackupSnapshot({
      workspace,
      action: 'delete_file',
      entries: [{ role: 'target-before', originalPath: 'protected-tree', sourcePath: protectedTree }]
    }),
    error => error?.code === 'sensitive_workspace_path'
  );
});

test('directory snapshots are first-class and backup/integrity tree scans are explicitly bounded', async () => {
  await resetBackupStore();
  const directory = path.join(workspaceRoot, 'tree');
  await fsp.mkdir(path.join(directory, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(directory, 'a.txt'), 'a', 'utf8');
  await fsp.writeFile(path.join(directory, 'nested', 'b.txt'), 'b', 'utf8');

  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'delete_file',
    entries: [{ role: 'target-before', originalPath: 'tree', sourcePath: directory }]
  });
  await store.completeBackupSnapshot(snapshot.id);
  const source = await store.backupEntry(snapshot.id, 'tree');
  assert.equal(source.entry.kind, 'directory');
  assert.equal(source.entry.fileCount, 2);

  const tinyDestination = path.join(root, 'tiny-copy');
  await assert.rejects(
    store.__test.snapshotDescriptor(
      directory,
      tinyDestination,
      { bytes: 0, files: 0, entries: 0, maxEntries: 1, maxBytes: 1024 * 1024 },
      'tree'
    ),
    error => error?.code === 'backup_snapshot_entry_limit'
  );
  await fsp.rm(tinyDestination, { recursive: true, force: true });

  await assert.rejects(
    store.__test.describePayload(
      source.payloadPath,
      { entries: 0, maxEntries: 1 },
      'tree'
    ),
    error => error?.code === 'backup_integrity_scan_limit'
  );
});

test('oversized snapshots fail before mutation', async () => {
  await resetBackupStore();
  const huge = path.join(workspaceRoot, 'huge.bin');
  await fsp.writeFile(huge, Buffer.alloc(1024 * 1024 + 1, 1));
  await assert.rejects(
    store.createBackupSnapshot({
      workspace,
      action: 'delete_file',
      entries: [{ role: 'target-before', originalPath: 'huge.bin', sourcePath: huge }],
      maxBackupBytes: 1024 * 1024
    }),
    error => error?.code === 'backup_snapshot_too_large'
  );
});

test('list filters understand directory descendants and reject malformed time filters', async () => {
  await resetBackupStore();
  const directory = path.join(workspaceRoot, 'filter-tree');
  await fsp.mkdir(path.join(directory, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(directory, 'nested', 'child.txt'), 'child\n', 'utf8');
  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'delete_file',
    entries: [{ role: 'target-before', originalPath: 'filter-tree', sourcePath: directory }]
  });
  await store.completeBackupSnapshot(snapshot.id);

  assert.equal((await store.listBackups({ path: 'filter-tree/nested/child.txt' }))[0]?.id, snapshot.id);
  await assert.rejects(store.listBackups({ since: 'not-a-date' }), /valid timestamp/);
  await assert.rejects(store.listBackups({ before: 'not-a-date' }), /valid timestamp/);
});

test('manifest validation fails closed for tampered totals and workspace identity', async () => {
  await resetBackupStore();
  const file = path.join(workspaceRoot, 'manifest.txt');
  await fsp.writeFile(file, 'manifest\n', 'utf8');
  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'manifest.txt', sourcePath: file }]
  });
  const manifestFile = path.join(backupRoot, snapshot.id, store.BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(await fsp.readFile(manifestFile, 'utf8'));

  assert.equal(store.__test.validManifest(manifest, snapshot.id), true);
  assert.equal(store.__test.validManifest({ ...manifest, totalBytes: manifest.totalBytes + 1 }, snapshot.id), false);
  assert.equal(store.__test.validManifest({
    ...manifest,
    workspace: { ...manifest.workspace, rootFingerprint: 'bad' }
  }, snapshot.id), false);
});

test('core write handler skips identical content instead of producing another backup', async () => {
  await resetBackupStore();
  const file = path.join(workspaceRoot, 'noop.txt');
  await fsp.writeFile(file, 'same\n', 'utf8');
  const before = await store.backupStoreStatus();
  const write = safeFileMutationHandler('write_file');
  const result = await write({ workspaceId: 'app', path: 'noop.txt', content: 'same\n' });
  assert.equal(result.structuredContent.noOp, true);
  assert.equal(result.structuredContent.written, false);
  const after = await store.backupStoreStatus();
  assert.equal(after.backupSets, before.backupSets);
});

test('concurrent snapshots cannot jointly cross the configured capacity budget', async () => {
  await resetBackupStore();
  const firstFile = path.join(workspaceRoot, 'capacity-a.txt');
  const secondFile = path.join(workspaceRoot, 'capacity-b.txt');
  await fsp.writeFile(firstFile, Buffer.alloc(700 * 1024, 1));
  await fsp.writeFile(secondFile, Buffer.alloc(700 * 1024, 2));

  const settled = await Promise.allSettled([
    store.createBackupSnapshot({
      workspace,
      action: 'write_file',
      entries: [{ role: 'target-before', originalPath: 'capacity-a.txt', sourcePath: firstFile }],
      maxBackupBytes: 1024 * 1024
    }),
    store.createBackupSnapshot({
      workspace,
      action: 'write_file',
      entries: [{ role: 'target-before', originalPath: 'capacity-b.txt', sourcePath: secondFile }],
      maxBackupBytes: 1024 * 1024
    })
  ]);
  const fulfilled = settled.filter(item => item.status === 'fulfilled');
  const rejected = settled.filter(item => item.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.code, 'backup_capacity_exhausted');
  await store.completeBackupSnapshot(fulfilled[0].value.id);
  const status = await store.backupStoreStatus();
  assert.equal(status.backupSets, 1);
  assert(status.backupBytes <= 1024 * 1024);
});

test('size pruning keeps the latest usable recovery point for every workspace and evicts from the larger consumer first', async () => {
  await resetBackupStore();
  const workspaceARoot = path.join(root, 'workspace-a');
  const workspaceBRoot = path.join(root, 'workspace-b');
  await fsp.mkdir(workspaceARoot, { recursive: true });
  await fsp.mkdir(workspaceBRoot, { recursive: true });
  const workspaceA = { id: 'workspace-a', name: 'Workspace A', root: workspaceARoot };
  const workspaceB = { id: 'workspace-b', name: 'Workspace B', root: workspaceBRoot };

  const a1 = await completeSnapshot({
    workspace: workspaceA,
    originalPath: 'a1.txt',
    sourcePath: path.join(workspaceARoot, 'a1.txt'),
    bytes: 600 * 1024
  });
  await new Promise(resolve => setTimeout(resolve, 3));
  const a2 = await completeSnapshot({
    workspace: workspaceA,
    originalPath: 'a2.txt',
    sourcePath: path.join(workspaceARoot, 'a2.txt'),
    bytes: 600 * 1024
  });
  await new Promise(resolve => setTimeout(resolve, 3));
  const a3 = await completeSnapshot({
    workspace: workspaceA,
    originalPath: 'a3.txt',
    sourcePath: path.join(workspaceARoot, 'a3.txt'),
    bytes: 600 * 1024
  });
  const b1 = await completeSnapshot({
    workspace: workspaceB,
    originalPath: 'b1.txt',
    sourcePath: path.join(workspaceBRoot, 'b1.txt'),
    bytes: 600 * 1024
  });

  const result = await store.pruneBackupStore({
    maxBackupBytes: 2 * 1024 * 1024,
    backupRetentionDays: 30
  });
  assert(result.afterBytes <= 2 * 1024 * 1024);
  assert(result.deleted.some(item => item.id === a1.id && item.reason === 'size-fair'));

  const a = await store.listBackups({ workspaceId: 'workspace-a', limit: 10 });
  const b = await store.listBackups({ workspaceId: 'workspace-b', limit: 10 });
  assert(a.some(item => item.id === a3.id));
  assert(a.some(item => item.id === a2.id));
  assert.equal(a.some(item => item.id === a1.id), false);
  assert.deepEqual(b.map(item => item.id), [b1.id]);
});

test('restore identity includes canonical workspace root fingerprint, not only workspace id', async () => {
  await resetBackupStore();
  const sourceFile = path.join(workspaceRoot, 'fingerprint.txt');
  await fsp.writeFile(sourceFile, 'fingerprint\n', 'utf8');
  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'fingerprint.txt', sourcePath: sourceFile }]
  });
  await store.completeBackupSnapshot(snapshot.id);
  const source = await store.backupEntry(snapshot.id, 'fingerprint.txt');
  const movedRoot = path.join(root, 'different-root');
  await fsp.mkdir(movedRoot, { recursive: true });

  assert.throws(
    () => store.assertBackupWorkspace(source.manifest, { id: workspace.id, root: movedRoot }),
    error => error?.code === 'backup_workspace_root_mismatch'
  );
});

test.after(async () => {
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(root, { recursive: true, force: true });
});
