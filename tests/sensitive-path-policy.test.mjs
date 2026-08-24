import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeWorkspacePath,
  isSafeProjectMetadataPath,
  isSafeWorkspaceTextPath,
  isSensitiveWorkspacePath,
  sensitiveWorkspacePathReason
} from '../gateway/sensitive-path-policy.mjs';

test('project automation metadata is allowed only outside protected parent directories', () => {
  assert.equal(isSafeProjectMetadataPath('.devmate/automation.json'), true);
  assert.equal(isSafeProjectMetadataPath('game/.devmate/automation.json'), true);
  assert.equal(isSensitiveWorkspacePath('.devmate/automation.json'), false);
  assert.equal(isSafeWorkspaceTextPath('.devmate/automation.json'), true);

  for (const value of [
    '.aws/.devmate/automation.json',
    'secrets/game/.devmate/automation.json',
    '.ssh/project/.devmate/automation.json',
    '.git/worktrees/example/.devmate/automation.json'
  ]) {
    assert.equal(isSafeProjectMetadataPath(value), false, value);
    assert.equal(isSensitiveWorkspacePath(value), true, value);
    assert.match(sensitiveWorkspacePathReason(value), /^sensitive-directory:/, value);
    assert.equal(isSafeWorkspaceTextPath(value), false, value);
  }
});

test('credential-shaped files remain protected while documented environment examples stay readable', () => {
  for (const value of [
    '.npmrc',
    'prod.env',
    '.env.local',
    '.aws/credentials',
    'application_default_credentials.json',
    'service-account-prod.json',
    'keys/signing.jks'
  ]) {
    assert.equal(isSensitiveWorkspacePath(value), true, value);
    assert.equal(isSafeWorkspaceTextPath(value), false, value);
    assert.throws(
      () => assertSafeWorkspacePath(value, 'Artifact path'),
      error => error?.code === 'protected_workspace_path' && error?.reason
    );
  }

  for (const value of ['.env.example', 'config/dev.env.sample', 'ops.env.template']) {
    assert.equal(isSensitiveWorkspacePath(value), false, value);
    assert.equal(isSafeWorkspaceTextPath(value), true, value);
    assert.equal(assertSafeWorkspacePath(value), value);
  }
});
