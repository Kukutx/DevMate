import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeWorkspacePath,
  assertSafeWorkspaceRoot,
  isSafeGodotBaselineMetadataPath,
  isSafeProjectMetadataPath,
  isSafeWorkspaceTextPath,
  isSensitiveWorkspacePath,
  sensitiveWorkspacePathReason,
  sensitiveWorkspaceRootReason
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

test('reviewed Godot baseline metadata is narrowly allowed inside .devmate', () => {
  for (const value of [
    '.devmate/baselines/godot/main.json',
    'game/.devmate/baselines/godot/main-linux-x64.json'
  ]) {
    assert.equal(isSafeGodotBaselineMetadataPath(value), true, value);
    assert.equal(isSafeProjectMetadataPath(value), true, value);
    assert.equal(isSensitiveWorkspacePath(value), false, value);
    assert.equal(isSafeWorkspaceTextPath(value), true, value);
  }

  for (const value of [
    '.devmate/baselines/godot/credentials.json',
    '.devmate/baselines/godot/service-account-prod.json',
    '.devmate/baselines/godot/nested/main.json',
    '.aws/.devmate/baselines/godot/main.json',
    '.devmate/baselines/other/main.json',
    '.devmate/state.json'
  ]) {
    assert.equal(isSafeGodotBaselineMetadataPath(value), false, value);
    assert.equal(isSensitiveWorkspacePath(value), true, value);
  }
});

test('credential-shaped and standalone control-plane files remain protected while documented environment examples stay readable', () => {
  for (const value of [
    '.npmrc',
    'prod.env',
    '.env.local',
    '.aws/credentials',
    'application_default_credentials.json',
    'service-account-prod.json',
    'keys/signing.jks',
    '.devmate-server/config.json',
    '.devmate-server/state/durable-state.json',
    '.devmate-server/state/oauth-secrets.json',
    'copied/oauth-secrets.json'
  ]) {
    assert.equal(isSensitiveWorkspacePath(value), true, value);
    assert.equal(isSafeWorkspaceTextPath(value), false, value);
    assert.throws(
      () => assertSafeWorkspacePath(value, 'Artifact path'),
      error => error?.code === 'protected_workspace_path' && typeof error?.reason === 'string' && error.reason.length > 0
    );
  }

  for (const value of ['.env.example', 'config/dev.env.sample', 'ops.env.template']) {
    assert.equal(isSensitiveWorkspacePath(value), false, value);
    assert.equal(isSafeWorkspaceTextPath(value), true, value);
    assert.equal(assertSafeWorkspacePath(value), value);
  }
});

test('a protected directory cannot become the workspace root and erase its own relative-path marker', () => {
  for (const value of [
    '/home/user/.aws',
    '/home/user/.devmate/desktop',
    '/srv/.devmate-server',
    '/tmp/secrets/project',
    'C:\\Users\\me\\.ssh\\project'
  ]) {
    assert.match(sensitiveWorkspaceRootReason(value), /^sensitive-directory:/, value);
    assert.throws(
      () => assertSafeWorkspaceRoot(value),
      error => error?.code === 'protected_workspace_root' && /^sensitive-directory:/.test(error?.reason || ''),
      value
    );
  }

  for (const value of ['/home/user/projects/app', 'C:\\Users\\me\\source\\app']) {
    assert.equal(sensitiveWorkspaceRootReason(value), '', value);
    assert.equal(assertSafeWorkspaceRoot(value), value);
  }
});
