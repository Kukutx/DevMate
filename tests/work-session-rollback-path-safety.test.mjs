import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-rollback-path-safety-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
const backupRoot = path.join(root, 'state', 'backups');
await fsp.mkdir(workspace, { recursive: true });
await fsp.mkdir(backupRoot, { recursive: true });
const config = configStore.newInstanceConfig({ workspaceRoot: workspace, appVersion: configStore.DEFAULT_VERSION });
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces = [{ id: 'app', name: 'Application', root: workspace, reference: false, mode: 'workspace-write', role: 'active' }];
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const rollback = await import('../gateway/work-session-rollback.mjs');

async function backup(rel, content = 'backup\n') {
  const full = path.join(backupRoot, '2026-08-24T00-00-00-000Z-1-deadbeef', ...rel.split('/'));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
  return full;
}

test('historical protected single-file backup cannot be restored under a safe target name', async () => {
  const source = await backup('.env', 'TOKEN=historical-secret\n');
  assert.equal(rollback.__test.backupOriginalRelative(backupRoot, source), '.env');
  assert.throws(
    () => rollback.__test.assertBackupSource(source),
    error => error?.code === 'sensitive_workspace_path' && /Backup source path/.test(error.message)
  );
});

test('historical protected nested backup cannot be disguised by a safe target path', async () => {
  const source = await backup('.aws/credentials', '[default]\nsecret=historical\n');
  assert.throws(
    () => rollback.__test.assertBackupSource(source),
    error => error?.code === 'sensitive_workspace_path' && error.reason === 'sensitive-directory:.aws'
  );
});

test('normal historical backup remains available and preserves its original relative path', async () => {
  const source = await backup('src/app.js', 'export const value = 1;\n');
  const accepted = rollback.__test.assertBackupSource(source);
  assert.equal(accepted.originalRel, 'src/app.js');
  assert.equal(accepted.path, await fsp.realpath(source));
});

test('rollback target policy blocks protected direct targets', () => {
  for (const rel of ['.npmrc', '.docker/config.json', '.kube/config', 'keys/release.p12']) {
    assert.throws(
      () => rollback.__test.assertSafeRollbackRel(rel),
      error => error?.code === 'sensitive_workspace_path'
    );
  }
  assert.equal(rollback.__test.assertSafeRollbackRel('src/app.js'), 'src/app.js');
});

test('rollback tree safety blocks a safe destination containing a protected descendant', async () => {
  const tree = path.join(root, 'tree-backup');
  await fsp.mkdir(path.join(tree, '.ssh'), { recursive: true });
  await fsp.writeFile(path.join(tree, '.ssh', 'id_ed25519'), 'private-key\n', 'utf8');
  await assert.rejects(
    rollback.__test.assertTreeSafe(tree, 'safe-directory'),
    error => error?.code === 'sensitive_workspace_path' && /safe-directory[\\/].ssh/.test(error.message)
  );
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(root, { recursive: true, force: true });
});
