import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-backup-access-guard-'));
const workspaceRoot = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspaceRoot, { recursive: true });
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';
const config = configStore.newInstanceConfig({ workspaceRoot, appVersion: configStore.DEFAULT_VERSION });
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'App', role: 'active' };
configStore.atomicWriteJson(configPath, config);

const store = await import('../gateway/backup-store.mjs');
const guard = await import('../gateway/backup-access-guard.mjs');
const workspace = { id: 'app', name: 'App', root: workspaceRoot };
await store.initializeBackupStore({ purgeLegacy: true });

async function safeBackup(originalPath, content = 'safe') {
  const source = path.join(workspaceRoot, ...String(originalPath).split('/').filter(Boolean));
  await fsp.mkdir(path.dirname(source), { recursive: true });
  await fsp.writeFile(source, content, 'utf8');
  const snapshot = await store.createBackupSnapshot({
    workspace,
    action: 'write_file',
    entries: [{ role: 'target-before', originalPath, sourcePath: source }]
  });
  await store.completeBackupSnapshot(snapshot.id);
  return snapshot.id;
}

test('new backup access uses manifest identity and store blocks protected paths', async () => {
  const id = await safeBackup('src/app.js');
  const source = await guard.__test.assertBackupAccess(id, 'src/app.js');
  assert.equal(source.entry.originalPath, 'src/app.js');

  for (const rel of ['.env', '.npmrc', '.aws/credentials', '.docker/config.json', 'keys/release.p12']) {
    const file = path.join(workspaceRoot, `secret-${Math.random().toString(16).slice(2)}.txt`);
    await fsp.writeFile(file, 'secret-like payload', 'utf8');
    await assert.rejects(
      store.createBackupSnapshot({
        workspace,
        action: 'write_file',
        entries: [{ role: 'target-before', originalPath: rel, sourcePath: file }]
      }),
      error => error?.cause?.code === 'sensitive_workspace_path' || error?.code === 'sensitive_workspace_path'
    );
  }
});

test('legacy path identifiers have no fallback', async () => {
  await assert.rejects(
    guard.__test.assertBackupAccess(path.join(root, 'state', 'backups', 'legacy', 'src', 'app.js')),
    error => error?.code === 'backup_id_invalid'
  );
  await assert.rejects(
    guard.__test.assertBackupAccess('2026-08-24T00-00-00-000Z-legacy'),
    error => error?.code === 'backup_id_invalid'
  );
});

test('list filtering remains fail-closed for protected manifest entries', () => {
  const safe = { id: 'bkp-safe', entries: [{ originalPath: 'src/app.js' }] };
  const result = {
    structuredContent: { backups: [
      safe,
      { id: 'bkp-secret', entries: [{ originalPath: '.env' }] },
      { id: 'bkp-nested', entries: [{ originalPath: '.kube/config' }] },
      { id: 'bkp-invalid', entries: [] }
    ] },
    content: [{ type: 'text', text: '{}' }]
  };
  guard.__test.filterBackupList(result);
  assert.deepEqual(result.structuredContent.backups, [safe]);
  assert.equal(result.structuredContent.sensitiveBackupsOmitted, 3);
  assert.doesNotMatch(result.content[0].text, /\.env|\.kube/);
});

test.after(async () => {
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(root, { recursive: true, force: true });
});
