import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __test,
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

test('parses fixed-length Runner secrets without confusing underscores', () => {
  const secret = `${'a'.repeat(20)}_${'b'.repeat(22)}`;
  assert.equal(secret.length, 43);
  assert.deepEqual(__test.parseRunnerToken(`dmr_linux_builder_${secret}`), {
    id: 'linux_builder',
    secret
  });
});

test('creates hashed, explicitly scoped runner credentials', () => {
  const current = config();
  const created = createRunnerCredential(current, {
    id: 'linux_builder',
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
