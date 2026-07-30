import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireWorkspaceLease,
  assertWorkspaceLease,
  clearWorkspaceLeases,
  releaseWorkspaceLease
} from '../gateway/workspace-leases.mjs';

test.afterEach(clearWorkspaceLeases);

test('requires the owning principal for shared workspace mutation', () => {
  const alice = { id: 'alice', name: 'Alice', role: 'developer', source: 'team-token' };
  const bob = { id: 'bob', name: 'Bob', role: 'developer', source: 'team-token' };
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
