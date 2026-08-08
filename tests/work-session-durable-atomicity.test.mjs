import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-work-session-durable-'));
process.env.DEVMATE_CONFIG = path.join(temp, 'config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, JSON.stringify({ version: 11 }), 'utf8');

const {
  clearWorkSessions,
  finishWorkSession,
  startWorkSession,
  syncWorkSessionsFromDurableState,
  workSessionStatus
} = await import('../gateway/work-sessions.mjs');
const {
  clearWorkspaceLeases,
  listWorkspaceLeases,
  syncWorkspaceLeasesFromDurableState,
  workspaceLease
} = await import('../gateway/workspace-leases.mjs');

const principal = {
  id: 'developer-durable',
  name: 'Durable Developer',
  role: 'developer',
  source: 'team-token',
  workspaceIds: ['app']
};

const stateRoot = path.join(temp, 'state');
const stateBackup = path.join(temp, 'state-preserved');

function reset() {
  clearWorkSessions();
  clearWorkspaceLeases();
}

function blockWritesPreservingState() {
  fs.rmSync(stateBackup, { recursive: true, force: true });
  if (fs.statSync(stateRoot, { throwIfNoEntry: false })) fs.renameSync(stateRoot, stateBackup);
  fs.writeFileSync(stateRoot, 'block durable-state directory creation', 'utf8');
}

function restorePreservedState() {
  fs.rmSync(stateRoot, { recursive: true, force: true });
  if (fs.statSync(stateBackup, { throwIfNoEntry: false })) fs.renameSync(stateBackup, stateRoot);
}

function reloadDurableState() {
  syncWorkSessionsFromDurableState();
  syncWorkspaceLeasesFromDurableState();
}

test.beforeEach(() => {
  restorePreservedState();
  reset();
});

test('failed start cannot persist only the lease half of a work session', () => {
  blockWritesPreservingState();
  try {
    assert.throws(() => startWorkSession({
      workspaceId: 'app',
      principal,
      ttlSeconds: 1800,
      purpose: 'preserved durable start failure'
    }));
  } finally {
    restorePreservedState();
  }

  reloadDurableState();
  assert.equal(workSessionStatus(principal).active, null);
  assert.deepEqual(listWorkspaceLeases(), []);
});

test('failed finish preserves both durable session and matching durable lease', () => {
  const started = startWorkSession({
    workspaceId: 'app',
    principal,
    ttlSeconds: 1800,
    purpose: 'preserved durable finish failure'
  });
  assert.equal(workspaceLease('app')?.id, started.lease.id);

  blockWritesPreservingState();
  try {
    assert.throws(() => finishWorkSession({
      principal,
      sessionId: started.session.id,
      releaseLease: true
    }));
  } finally {
    restorePreservedState();
  }

  reloadDurableState();
  const session = workSessionStatus(principal).active;
  const lease = workspaceLease('app');
  assert.equal(session?.id, started.session.id);
  assert.equal(session?.leaseId, started.lease.id);
  assert.equal(lease?.id, started.lease.id);
  assert.equal(lease?.principalId, principal.id);
});

test.after(() => {
  try { restorePreservedState(); } catch {}
  try { reset(); } catch {}
  return fsp.rm(temp, { recursive: true, force: true });
});
