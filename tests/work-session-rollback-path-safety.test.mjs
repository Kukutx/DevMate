import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-rollback-safety-'));
const workspaceRoot = path.join(root, 'workspace');
const otherRoot = path.join(root, 'other');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspaceRoot, { recursive: true });
await fsp.mkdir(otherRoot, { recursive: true });
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';
const config = configStore.newInstanceConfig({ workspaceRoot, appVersion: configStore.DEFAULT_VERSION });
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces = [
  { id: 'app', name: 'Application', root: workspaceRoot, reference: false, mode: 'workspace-write', role: 'active' },
  { id: 'other', name: 'Other', root: otherRoot, reference: false, mode: 'workspace-write', role: 'workspace' }
];
configStore.atomicWriteJson(configPath, config);

const store = await import('../gateway/backup-store.mjs');
const { safeFileMutationHandler } = await import('../gateway/file-mutation-safety.mjs');
const { runWithWorkSessionContext } = await import('../gateway/request-context.mjs');
const { rollbackWorkSession } = await import('../gateway/work-session-rollback.mjs');
const { startWorkSession, clearWorkSessions } = await import('../gateway/work-sessions.mjs');
const { clearWorkspaceLeases } = await import('../gateway/workspace-leases.mjs');
await store.initializeBackupStore({ purgeLegacy: true });
const workspace = { id: 'app', name: 'Application', root: workspaceRoot };
const owner = { id: 'local-owner', name: 'Local owner', role: 'owner', workspaceIds: [] };

async function exists(file) {
  return fsp.stat(file).then(() => true, () => false);
}

test('backup store rejects protected descendants inside otherwise safe directories', async () => {
  const tree = path.join(workspaceRoot, 'safe-directory');
  await fsp.mkdir(path.join(tree, '.ssh'), { recursive: true });
  await fsp.writeFile(path.join(tree, '.ssh', 'id_ed25519'), 'private-key\n', 'utf8');
  await assert.rejects(
    store.createBackupSnapshot({
      workspace,
      action: 'delete_file',
      entries: [{ role: 'target-before', originalPath: 'safe-directory', sourcePath: tree }]
    }),
    error => error?.cause?.code === 'sensitive_workspace_path' || error?.code === 'sensitive_workspace_path'
  );
});

test('restore is pinned to manifest workspace and protected target rules', async () => {
  const sourceFile = path.join(workspaceRoot, 'src', 'app.js');
  await fsp.mkdir(path.dirname(sourceFile), { recursive: true });
  await fsp.writeFile(sourceFile, 'safe\n', 'utf8');
  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath: 'src/app.js', sourcePath: sourceFile }]
  });
  await store.completeBackupSnapshot(snapshot.id);
  const restore = safeFileMutationHandler('restore_backup');
  await assert.rejects(
    restore({ workspaceId: 'other', backupId: snapshot.id, entryPath: 'src/app.js' }),
    error => error?.code === 'backup_workspace_mismatch'
  );
  await assert.rejects(
    restore({ workspaceId: 'app', backupId: snapshot.id, entryPath: 'src/app.js', targetPath: '.env' }),
    /secret\/binary\/hidden path/
  );
});

test('work-session rollback restores a deleted directory from manifest history without audit metadata', async () => {
  clearWorkspaceLeases();
  clearWorkSessions();
  const session = startWorkSession({ principal: owner, workspaceId: 'app', ttlSeconds: 300 });
  const tree = path.join(workspaceRoot, 'rollback-tree');
  await fsp.mkdir(path.join(tree, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(tree, 'a.txt'), 'a\n', 'utf8');
  await fsp.writeFile(path.join(tree, 'nested', 'b.txt'), 'b\n', 'utf8');
  const snapshot = await runWithWorkSessionContext(session.id, () => store.createBackupSnapshot({
    workspace,
    action: 'delete_file',
    entries: [{ role: 'target-before', originalPath: 'rollback-tree', sourcePath: tree }]
  }));
  await store.completeBackupSnapshot(snapshot.id);
  await fsp.rm(tree, { recursive: true, force: true });
  assert.equal(await exists(tree), false);

  const result = await rollbackWorkSession({ workSessionId: session.id, principal: owner });
  assert.equal(result.snapshots, 1);
  assert.equal(await fsp.readFile(path.join(tree, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(await fsp.readFile(path.join(tree, 'nested', 'b.txt'), 'utf8'), 'b\n');
});

test.after(async () => {
  clearWorkspaceLeases();
  clearWorkSessions();
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(root, { recursive: true, force: true });
});
