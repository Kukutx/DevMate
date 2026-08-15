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
  assertWorkspaceLease,
  clearWorkspaceLeases,
  releaseWorkspaceLease
} = await import('../gateway/workspace-leases.mjs');

test.beforeEach(clearWorkspaceLeases);
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

test.after(async () => {
  try { clearWorkspaceLeases(); } catch {}
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
