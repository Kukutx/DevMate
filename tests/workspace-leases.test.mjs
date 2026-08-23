import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-workspace-leases-'));
process.env.DEVMATE_CONFIG = path.join(temp, 'config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, JSON.stringify({ version: 11 }), 'utf8');

const {
  acquireWorkspaceLease,
  acquireWorkspaceLeaseHold,
  assertWorkspaceLease,
  clearWorkspaceLeases,
  releaseWorkspaceLease,
  releaseWorkspaceLeaseHold,
  workspaceLease
} = await import('../gateway/workspace-leases.mjs');

test.beforeEach(clearWorkspaceLeases);
test.afterEach(clearWorkspaceLeases);

test('requires the owning principal for shared workspace mutation', () => {
  const alice = { id: 'alice', name: 'Alice', role: 'developer', source: 'oauth-member' };
  const bob = { id: 'bob', name: 'Bob', role: 'developer', source: 'oauth-member' };
  const config = { team: { enabled: true, requireWorkspaceLeaseForWrites: true } };
  assert.throws(() => assertWorkspaceLease({
    workspaceId: 'app', principal: alice, capability: 'write', config
  }), /requires a lease/);
  acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 120 });
  assert.ok(assertWorkspaceLease({ workspaceId: 'app', principal: alice, capability: 'write', config }));
  assert.throws(() => assertWorkspaceLease({
    workspaceId: 'app', principal: bob, capability: 'write', config
  }), /leased by/);
  assert.equal(releaseWorkspaceLease({ workspaceId: 'app', principal: alice }).released, true);
});

test('active operation hold prevents expiry takeover, force takeover, and early release', () => {
  const base = Date.now();
  const alice = { id: 'alice', name: 'Alice', role: 'developer', source: 'oauth-member' };
  const bob = { id: 'bob', name: 'Bob', role: 'developer', source: 'oauth-member' };
  const maintainer = { id: 'maintainer', name: 'Maintainer', role: 'maintainer', source: 'oauth-member' };
  const config = {
    team: { enabled: true, requireWorkspaceLeaseForWrites: true },
    requestPolicy: { requestTimeoutMs: 60_000 },
    runtime: { defaultCommandTimeoutMs: 60_000 }
  };

  const lease = acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 60, now: base });
  const hold = acquireWorkspaceLeaseHold({
    workspaceId: 'app',
    principal: alice,
    capability: 'write',
    config,
    holdMs: 180_000,
    purpose: 'write_file',
    now: base
  });
  assert.equal(hold.leaseId, lease.id);
  assert.equal(workspaceLease('app').activeOperations, 1);

  const afterBaseExpiry = base + 90_000;
  assert.throws(
    () => acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 120, now: afterBaseExpiry }),
    /leased by Alice/
  );
  assert.throws(
    () => acquireWorkspaceLease({ workspaceId: 'app', principal: maintainer, ttlSeconds: 120, force: true, now: afterBaseExpiry }),
    error => error?.code === 'workspace_lease_active_operations'
  );
  assert.throws(
    () => releaseWorkspaceLease({ workspaceId: 'app', principal: alice, now: afterBaseExpiry }),
    error => error?.code === 'workspace_lease_active_operations'
  );

  assert.equal(releaseWorkspaceLeaseHold({
    workspaceId: 'app',
    holdId: hold.id,
    leaseId: hold.leaseId,
    principalId: alice.id,
    now: afterBaseExpiry
  }), true);
  assert.equal(workspaceLease('app'), null);

  const bobLease = acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 120, now: afterBaseExpiry });
  assert.equal(bobLease.principalId, 'bob');
});

test('expired operation holds cannot wedge a workspace after a crashed operation', () => {
  const base = Date.now();
  const alice = { id: 'alice', name: 'Alice', role: 'developer', source: 'oauth-member' };
  const bob = { id: 'bob', name: 'Bob', role: 'developer', source: 'oauth-member' };
  const config = {
    team: { requireWorkspaceLeaseForWrites: true },
    requestPolicy: { requestTimeoutMs: 60_000 },
    runtime: { defaultCommandTimeoutMs: 60_000 }
  };
  acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 60, now: base });
  acquireWorkspaceLeaseHold({
    workspaceId: 'app', principal: alice, capability: 'execute', config, holdMs: 60_000, now: base
  });

  const takeover = acquireWorkspaceLease({
    workspaceId: 'app', principal: bob, ttlSeconds: 120, now: base + 61_000
  });
  assert.equal(takeover.principalId, 'bob');
});

test.after(async () => {
  try { clearWorkspaceLeases(); } catch {}
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
