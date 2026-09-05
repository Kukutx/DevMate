import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-work-session-rollback-auth-'));
const workspaceRoot = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
await fsp.mkdir(workspaceRoot, { recursive: true });
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const config = configStore.newInstanceConfig({ workspaceRoot, appVersion: configStore.DEFAULT_VERSION });
config.auth = { mode: 'oauth' };
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'app', role: 'active' };
config.team.requireWorkspaceLeaseForWrites = true;
const teamAccess = await import('../gateway/team-access.mjs');
const aliceCreated = teamAccess.createTeamMember(config, { id: 'alice', name: 'Alice', role: 'developer', workspaceIds: ['app'] });
const bobCreated = teamAccess.createTeamMember(config, { id: 'bob', name: 'Bob', role: 'maintainer', workspaceIds: ['app'] });
configStore.atomicWriteJson(configPath, config);
const alice = teamAccess.verifyMemberLoginCode(aliceCreated.loginCode, config);
const bob = teamAccess.verifyMemberLoginCode(bobCreated.loginCode, config);

const store = await import('../gateway/backup-store.mjs');
const { runWithWorkSessionContext } = await import('../gateway/request-context.mjs');
const { rollbackWorkSession } = await import('../gateway/work-session-rollback.mjs');
const { startWorkSession, clearWorkSessions } = await import('../gateway/work-sessions.mjs');
const { acquireWorkspaceLease, clearWorkspaceLeases } = await import('../gateway/workspace-leases.mjs');
const workspace = { id: 'app', name: 'app', root: workspaceRoot };
await store.initializeBackupStore({ purgeLegacy: true });

async function recordCreatedSession(principal, fileName) {
  const session = startWorkSession({ principal, workspaceId: 'app', ttlSeconds: 300 });
  const file = path.join(workspaceRoot, fileName);
  const snapshot = await runWithWorkSessionContext(session.id, () => store.createBackupSnapshot({
    workspace,
    action: 'create_file',
    entries: [{ role: 'target-before', originalPath: fileName, sourcePath: null }]
  }));
  await store.completeBackupSnapshot(snapshot.id);
  await fsp.writeFile(file, 'created in session', 'utf8');
  return { session, file };
}

test('maintainer must opt in with force before rolling back another principal manifest history', async () => {
  clearWorkspaceLeases();
  clearWorkSessions();
  const { session, file } = await recordCreatedSession(alice, 'alice-created.txt');
  clearWorkspaceLeases();
  acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 300 });

  await assert.rejects(
    rollbackWorkSession({ workSessionId: session.id, principal: bob }),
    /requires force=true/
  );
  assert.equal(await fsp.stat(file).then(() => true, () => false), true);

  const result = await rollbackWorkSession({ workSessionId: session.id, principal: bob, force: true });
  assert.equal(result.force, true);
  assert.equal(result.snapshots, 1);
  assert.equal(await fsp.stat(file).then(() => true, () => false), false);
});

test('rollback does not depend on audit history and fails closed for unknown session ids', async () => {
  clearWorkspaceLeases();
  acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 300 });
  await assert.rejects(
    rollbackWorkSession({ workSessionId: 'work-no-manifest-history', principal: alice }),
    /backup history not found/
  );
});

test('rollback restores crash-unknown prepared snapshots but skips explicitly failed snapshots', async () => {
  clearWorkspaceLeases();
  clearWorkSessions();
  const session = startWorkSession({ principal: alice, workspaceId: 'app', ttlSeconds: 300 });
  const crashFileName = 'crash-unknown-created.txt';
  const failedFileName = 'failed-created-later.txt';

  const prepared = await runWithWorkSessionContext(session.id, () => store.createBackupSnapshot({
    workspace,
    action: 'create_file',
    entries: [{ role: 'target-before', originalPath: crashFileName, sourcePath: null }]
  }));
  assert.equal(prepared.mutationState, 'prepared');
  await fsp.writeFile(path.join(workspaceRoot, crashFileName), 'mutation happened before crash metadata', 'utf8');

  const failed = await runWithWorkSessionContext(session.id, () => store.createBackupSnapshot({
    workspace,
    action: 'create_file',
    entries: [{ role: 'target-before', originalPath: failedFileName, sourcePath: null }]
  }));
  const simulated = new Error('known mutation failure');
  simulated.code = 'KNOWN_FAILURE';
  await store.failBackupSnapshot(failed.id, simulated);
  await fsp.writeFile(path.join(workspaceRoot, failedFileName), 'later unrelated file', 'utf8');

  clearWorkspaceLeases();
  acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 300 });
  const result = await rollbackWorkSession({ workSessionId: session.id, principal: alice });
  assert.equal(result.snapshots, 1);
  assert.equal(result.failedSnapshotsSkipped, 1);
  assert.equal(await fsp.stat(path.join(workspaceRoot, crashFileName)).then(() => true, () => false), false);
  assert.equal(await fsp.readFile(path.join(workspaceRoot, failedFileName), 'utf8'), 'later unrelated file');
});

test.after(async () => {
  clearWorkspaceLeases();
  clearWorkSessions();
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
