import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireWorkspaceLease,
  clearWorkspaceLeases,
  workspaceLease
} from '../gateway/workspace-leases.mjs';
import {
  clearWorkSessions,
  finishWorkSession,
  listWorkSessions,
  startWorkSession
} from '../gateway/work-sessions.mjs';

const alice = { id: 'alice', name: 'Alice', role: 'developer', workspaceIds: ['app'], source: 'team-token' };
const bob = { id: 'bob', name: 'Bob', role: 'maintainer', workspaceIds: ['app'], source: 'team-token' };

test.afterEach(() => {
  clearWorkSessions();
  clearWorkspaceLeases();
});

test('finishing a work session releases only its matching lease', () => {
  const session = startWorkSession({ principal: alice, workspaceId: 'app', ttlSeconds: 300 });
  assert.equal(workspaceLease('app')?.id, session.leaseId);

  const result = finishWorkSession({ id: session.id, principal: alice });
  assert.equal(result.finished, true);
  assert.equal(result.lease?.released, true);
  assert.equal(result.lease?.lease?.id, session.leaseId);
  assert.equal(workspaceLease('app'), null);
  assert.equal(listWorkSessions().length, 0);
});

test('force takeover rotates lease identity', () => {
  const session = startWorkSession({ principal: alice, workspaceId: 'app', ttlSeconds: 300 });
  const takeover = acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 300, force: true });

  assert.equal(takeover.principalId, bob.id);
  assert.notEqual(takeover.id, session.leaseId);
});

test('finishing a stale session never releases a later takeover lease', () => {
  const session = startWorkSession({ principal: alice, workspaceId: 'app', ttlSeconds: 300 });
  const takeover = acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 300, force: true });

  const result = finishWorkSession({ id: session.id, principal: alice });
  assert.equal(result.finished, true);
  assert.equal(result.lease?.released, false);
  assert.equal(result.lease?.reason, 'lease changed since session started');
  assert.deepEqual(workspaceLease('app'), takeover);
  assert.equal(listWorkSessions().length, 0);
});

test('forced session cleanup never releases the maintainer takeover lease', () => {
  const session = startWorkSession({ principal: alice, workspaceId: 'app', ttlSeconds: 300 });
  const takeover = acquireWorkspaceLease({ workspaceId: 'app', principal: bob, ttlSeconds: 300, force: true });

  const result = finishWorkSession({ id: session.id, principal: bob, force: true });
  assert.equal(result.finished, true);
  assert.equal(result.lease?.released, false);
  assert.equal(result.lease?.reason, 'lease changed since session started');
  assert.deepEqual(workspaceLease('app'), takeover);
  assert.equal(listWorkSessions().length, 0);
});
