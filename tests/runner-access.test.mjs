import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRunnerCredential,
  normalizeRunnerControlConfig,
  revokeRunnerCredential,
  rotateRunnerCredentialToken,
  updateRunnerCredential,
  verifyRunnerToken
} from '../gateway/runner-access.mjs';

function config() {
  return { runnerControl: { enabled: false, credentials: [] } };
}

test('creates hashed, explicitly scoped runner credentials', () => {
  const current = config();
  const created = createRunnerCredential(current, {
    name: 'Linux Builder',
    workspaceIds: ['app'],
    capabilities: ['core', 'external', 'linux-x64'],
    maxConcurrent: 3
  });
  assert.match(created.token, /^dmr_/);
  assert.equal(current.runnerControl.enabled, true);
  assert.equal(current.runnerControl.credentials[0].tokenHash.includes(created.token), false);
  const principal = verifyRunnerToken(created.token, current);
  assert.equal(principal.id, created.credential.id);
  assert.deepEqual(principal.workspaceIds, ['app']);
  assert.equal(principal.capabilities.includes('external'), true);
  assert.equal(principal.maxConcurrent, 3);
});

test('rejects unscoped external runner credentials', () => {
  const current = config();
  assert.throws(() => createRunnerCredential(current, { name: 'Unsafe' }), /at least one explicit workspaceId/);
});

test('updates, rotates, expires, and revokes runner credentials', () => {
  const current = config();
  normalizeRunnerControlConfig(current);
  const created = createRunnerCredential(current, { name: 'Runner', workspaceIds: ['app'] });
  const updated = updateRunnerCredential(current, created.credential.id, {
    workspaceIds: ['app', 'tests'],
    capabilities: ['godot'],
    maxConcurrent: 2
  });
  assert.deepEqual(updated.workspaceIds, ['app', 'tests']);
  assert.equal(updated.capabilities.includes('core'), true);
  assert.equal(updated.capabilities.includes('external'), true);
  const rotated = rotateRunnerCredentialToken(current, created.credential.id);
  assert.equal(verifyRunnerToken(created.token, current), null);
  assert.equal(verifyRunnerToken(rotated.token, current).tokenVersion, 2);
  revokeRunnerCredential(current, created.credential.id);
  assert.equal(verifyRunnerToken(rotated.token, current), null);
});
