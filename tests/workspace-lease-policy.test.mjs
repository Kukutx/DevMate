import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-workspace-lease-policy-'));
process.env.DEVMATE_CONFIG = path.join(temp, 'config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, JSON.stringify({ version: 11 }), 'utf8');

const {
  acquireWorkspaceLease,
  assertWorkspaceLease,
  clearWorkspaceLeases
} = await import('../gateway/workspace-leases.mjs');

const config = {
  team: { requireWorkspaceLeaseForWrites: true }
};

const teamOwner = {
  id: 'team-owner',
  name: 'Team Owner',
  role: 'owner',
  source: 'team-token',
  workspaceIds: ['app']
};
const ownerToken = {
  id: 'owner',
  name: 'Owner',
  role: 'owner',
  source: 'owner-token',
  workspaceIds: []
};
const localOwner = {
  id: 'local-owner',
  name: 'Local Owner',
  role: 'owner',
  source: 'local',
  workspaceIds: []
};

test.beforeEach(() => clearWorkspaceLeases());

test('explicit lease policy applies to remote owner identities as well as members', () => {
  for (const principal of [teamOwner, ownerToken]) {
    assert.throws(() => assertWorkspaceLease({
      workspaceId: 'app',
      principal,
      capability: 'write',
      config
    }), /requires a lease/);
    const lease = acquireWorkspaceLease({ workspaceId: 'app', principal, ttlSeconds: 1800, force: true });
    assert.equal(assertWorkspaceLease({
      workspaceId: 'app',
      principal,
      capability: 'write',
      config
    })?.id, lease.id);
    clearWorkspaceLeases();
  }
});

test('local owner remains the recovery path when remote lease enforcement is enabled', () => {
  assert.equal(assertWorkspaceLease({
    workspaceId: 'app',
    principal: localOwner,
    capability: 'write',
    config
  }), null);
});

test.after(() => {
  try { clearWorkspaceLeases(); } catch {}
  return fsp.rm(temp, { recursive: true, force: true });
});
