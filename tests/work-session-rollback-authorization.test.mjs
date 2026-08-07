import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-work-session-rollback-auth-'));
const workspaceRoot = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
await fsp.mkdir(workspaceRoot, { recursive: true });
process.env.DEVMATE_CONFIG = configPath;

await fsp.writeFile(configPath, JSON.stringify({
  version: 11,
  auth: { required: true, token: 'owner-token-value-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'team', tunnelProvider: 'external', publicUrl: 'https://devmate.example.com' },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: true },
  production: {},
  maintenance: { auditRetentionDays: 90 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'app', root: workspaceRoot, mode: 'workspace-write', reference: false }]
}, null, 2), 'utf8');

const { audit } = await import('../gateway/local-shared.mjs');
const { rollbackWorkSession } = await import('../gateway/work-session-rollback.mjs');
const { acquireWorkspaceLease, clearWorkspaceLeases } = await import('../gateway/workspace-leases.mjs');

const alice = { id: 'alice', name: 'Alice', role: 'developer', workspaceIds: ['app'], source: 'team-token' };
const bob = { id: 'bob', name: 'Bob', role: 'maintainer', workspaceIds: ['app'], source: 'team-token' };

async function recordCreatedSession(id, principal, fileName) {
  const file = path.join(workspaceRoot, fileName);
  await fsp.writeFile(file, 'created in session', 'utf8');
  await audit('work_session_start', {
    principalId: principal.id,
    principalName: principal.name,
    workspace: 'app'
  }, { workSessionId: id });
  await audit('create_file', {
    workspace: 'app',
    path: fileName,
    backup: null
  }, { workSessionId: id });
  return file;
}

test('maintainer must opt in with force before rolling back another principal session', async () => {
  clearWorkspaceLeases();
  const id = 'work-owned-by-alice';
  const file = await recordCreatedSession(id, alice, 'alice-created.txt');
  acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 300 });

  await assert.rejects(
    rollbackWorkSession({ workSessionId: id, principal: bob }),
    /requires force=true/
  );
  assert.equal(await fsp.stat(file).then(() => true, () => false), true);

  const result = await rollbackWorkSession({ workSessionId: id, principal: bob, force: true });
  assert.equal(result.force, true);
  assert.equal(await fsp.stat(file).then(() => true, () => false), false);
});

test('rollback refuses audit history when session ownership metadata is unavailable', async () => {
  clearWorkspaceLeases();
  const id = 'work-missing-owner';
  const fileName = 'unknown-created.txt';
  const file = path.join(workspaceRoot, fileName);
  await fsp.writeFile(file, 'unknown owner', 'utf8');
  await audit('create_file', {
    workspace: 'app',
    path: fileName,
    backup: null
  }, { workSessionId: id });
  acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 300 });

  await assert.rejects(
    rollbackWorkSession({ workSessionId: id, principal: alice }),
    /ownership metadata is unavailable/
  );
  assert.equal(await fsp.stat(file).then(() => true, () => false), true);
});

test.after(async () => {
  clearWorkspaceLeases();
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
