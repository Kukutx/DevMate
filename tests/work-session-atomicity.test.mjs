import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-work-session-atomic-'));
process.env.DEVMATE_CONFIG = path.join(temp, 'config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, JSON.stringify({ version: 11 }), 'utf8');

const {
  activeWorkSession,
  clearWorkSessions,
  finishWorkSession,
  startWorkSession
} = await import('../gateway/work-sessions.mjs');
const {
  clearWorkspaceLeases,
  listWorkspaceLeases,
  workspaceLease
} = await import('../gateway/workspace-leases.mjs');

const principal = { id: 'developer-atomic', name: 'Atomic Developer', role: 'developer', source: 'team-token', workspaceIds: ['app'] };
const stateRoot = () => path.join(temp, 'state');
function blockDurableWrites() { fs.rmSync(stateRoot(), { recursive: true, force: true }); fs.writeFileSync(stateRoot(), 'blocked', 'utf8'); }
function restoreDurableWrites() { fs.rmSync(stateRoot(), { force: true }); fs.mkdirSync(stateRoot(), { recursive: true }); }
function reset() { clearWorkSessions(); clearWorkspaceLeases(); }

test.beforeEach(() => reset());

test('failed work_session_start leaves neither an in-memory nor durable orphan lease', () => {
  blockDurableWrites();
  try {
    assert.throws(() => startWorkSession({ workspaceId: 'app', principal, ttlSeconds: 1800, purpose: 'atomic start failure' }));
  } finally { restoreDurableWrites(); }
  assert.equal(activeWorkSession(principal.id, 'app'), null);
  assert.deepEqual(listWorkspaceLeases(), []);
});

test('failed work_session_finish preserves both the active session and its matching lease', () => {
  const started = startWorkSession({ workspaceId: 'app', principal, ttlSeconds: 1800, purpose: 'atomic finish failure' });
  assert.equal(workspaceLease('app')?.id, started.lease.id);
  blockDurableWrites();
  try {
    assert.throws(() => finishWorkSession({ id: started.id, principal, releaseLease: true }));
  } finally { restoreDurableWrites(); }
  const session = activeWorkSession(principal.id, 'app');
  const lease = workspaceLease('app');
  assert.equal(session?.id, started.id);
  assert.equal(session?.leaseId, started.lease.id);
  assert.equal(lease?.id, started.lease.id);
  assert.equal(lease?.principalId, principal.id);
});

test.after(() => {
  try { restoreDurableWrites(); } catch {}
  try { reset(); } catch {}
  return fsp.rm(temp, { recursive: true, force: true });
});
