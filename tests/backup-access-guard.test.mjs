import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-backup-access-guard-'));
const configPath = path.join(root, 'config.json');
const backupRoot = path.join(root, 'state', 'backups');
process.env.DEVMATE_CONFIG = configPath;
await fsp.mkdir(backupRoot, { recursive: true });
await fsp.writeFile(configPath, '{"version":11}\n', 'utf8');

const guard = await import('../gateway/backup-access-guard.mjs');

function backupPath(rel, stamp = '2026-08-24T00-00-00-000Z-1-deadbeef') {
  return path.join(backupRoot, stamp, ...rel.split('/'));
}

test('derives the original workspace path from automatic backup layout', () => {
  assert.equal(guard.__test.backupOriginalRelative(backupPath('src/app.js')), 'src/app.js');
  assert.equal(guard.__test.backupOriginalRelative(backupPath('.aws/credentials')), '.aws/credentials');
});

test('restore access rejects protected historical backup sources even with a safe future target', () => {
  for (const rel of ['.env', '.npmrc', '.aws/credentials', '.docker/config.json', 'keys/release.p12']) {
    assert.throws(
      () => guard.__test.assertBackupAccess(backupPath(rel)),
      error => error?.code === 'sensitive_workspace_path'
    );
  }
  const safe = guard.__test.assertBackupAccess(backupPath('src/app.js'));
  assert.equal(safe.originalRel, 'src/app.js');
});

test('backup paths outside the automatic backup root fail closed', () => {
  assert.throws(
    () => guard.__test.assertBackupAccess(path.join(root, 'elsewhere', 'stamp', 'src', 'app.js')),
    error => error?.code === 'backup_path_invalid'
  );
  assert.throws(
    () => guard.__test.assertBackupAccess(path.join(backupRoot, 'orphan-without-original-path')),
    error => error?.code === 'backup_path_invalid'
  );
});

test('list_backups hides protected historical entries and reports the omission count', () => {
  const result = {
    structuredContent: {
      backups: [
        { path: backupPath('src/app.js'), size: 10 },
        { path: backupPath('.env'), size: 20 },
        { path: backupPath('.kube/config'), size: 30 },
        { path: path.join(root, 'not-a-backup'), size: 40 }
      ]
    },
    content: [{ type: 'text', text: '{}' }]
  };
  guard.__test.filterBackupList(result);
  assert.deepEqual(result.structuredContent.backups, [{ path: backupPath('src/app.js'), size: 10 }]);
  assert.equal(result.structuredContent.sensitiveBackupsOmitted, 3);
  assert.match(result.content[0].text, /sensitiveBackupsOmitted/);
  assert.doesNotMatch(result.content[0].text, /\.env|\.kube/);
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(root, { recursive: true, force: true });
});
