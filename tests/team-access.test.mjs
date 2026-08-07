import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __test,
  authorizeToolCall,
  createTeamMember,
  normalizeDeploymentConfig,
  requiredCapabilityForTool,
  revokeTeamMember,
  rotateTeamMemberToken,
  toolWorkspaceId,
  updateTeamMember,
  verifyAccessToken
} from '../gateway/team-access.mjs';

function config() {
  return {
    auth: { required: true, token: 'owner-secret-token-value' },
    permissions: { profile: 'fullAccess' },
    deployment: { mode: 'team' },
    team: { members: [] },
    production: {},
    activeWorkspaceId: 'app',
    workspaces: [{ id: 'app', name: 'Application', reference: false, mode: 'workspace-write' }]
  };
}

test('parses fixed-length member secrets without confusing underscores', () => {
  const secret = `${'a'.repeat(20)}_${'b'.repeat(22)}`;
  assert.equal(secret.length, 43);
  assert.deepEqual(__test.parseTeamToken(`dmt_data_ops_${secret}`), {
    id: 'data_ops',
    secret
  });
});

test('creates hashed team tokens and verifies scoped principals', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const created = createTeamMember(current, {
    id: 'data_ops',
    name: 'Alice',
    role: 'developer',
    workspaceIds: ['app']
  });
  assert.match(created.token, /^dmt_/);
  assert.equal(current.team.members[0].tokenHash.includes(created.token), false);
  const principal = verifyAccessToken(created.token, current);
  assert.equal(principal.id, created.member.id);
  assert.equal(principal.role, 'developer');
  assert.deepEqual(principal.workspaceIds, ['app']);
});

test('rotating a revoked Team token does not reactivate the member', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const created = createTeamMember(current, {
    id: 'revoked-member',
    name: 'Revoked member',
    role: 'developer',
    workspaceIds: ['app']
  });
  revokeTeamMember(current, created.member.id);
  const rotated = rotateTeamMemberToken(current, created.member.id);
  assert.equal(rotated.member.disabled, true);
  assert.equal(verifyAccessToken(rotated.token, current), null);
  updateTeamMember(current, created.member.id, { disabled: false });
  assert.equal(verifyAccessToken(rotated.token, current)?.id, created.member.id);
});

test('rejects empty Team workspace scopes instead of treating them as global access', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  assert.throws(() => createTeamMember(current, {
    name: 'Unscoped',
    role: 'developer',
    workspaceIds: []
  }), /at least one explicit workspace ID/);

  const created = createTeamMember(current, {
    name: 'Scoped',
    role: 'developer',
    workspaceIds: ['app']
  });
  current.team.members[0].workspaceIds = [];
  assert.equal(verifyAccessToken(created.token, current), null, 'historical unscoped credentials must be invalid');
});

test('enforces role capabilities and workspace scopes', () => {
  const current = config();
  current.workspaces.push({ id: 'other', name: 'Other', reference: false, mode: 'workspace-write' });
  normalizeDeploymentConfig(current);
  const reviewer = {
    id: 'r',
    name: 'Reviewer',
    role: 'reviewer',
    workspaceIds: ['app'],
    source: 'team-token'
  };
  assert.equal(authorizeToolCall({
    name: 'godot_validate',
    annotations: { destructiveHint: true },
    args: { workspaceId: 'app' },
    config: current,
    principal: reviewer
  }).capability, 'validate');
  assert.throws(() => authorizeToolCall({
    name: 'write_file',
    annotations: { destructiveHint: true },
    args: { workspaceId: 'app' },
    config: current,
    principal: reviewer
  }), /cannot use/);
  assert.throws(() => authorizeToolCall({
    name: 'read_file',
    annotations: { readOnlyHint: true },
    args: { workspaceId: 'other' },
    config: current,
    principal: reviewer
  }), /not allowed to access workspace other/);
});

test('personal owner token remains unrestricted by Team workspace scope', () => {
  const current = config();
  current.workspaces.push({ id: 'other', name: 'Other', reference: false, mode: 'workspace-write' });
  normalizeDeploymentConfig(current);
  const principal = verifyAccessToken('owner-secret-token-value', current);
  assert.equal(principal.role, 'owner');
  assert.equal(principal.source, 'personal-token');
  assert.equal(authorizeToolCall({
    name: 'read_file',
    annotations: { readOnlyHint: true },
    args: { workspaceId: 'other' },
    config: current,
    principal
  }).workspaceId, 'other');
});

test('blocks high-risk operations for team tokens even under full local access', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const maintainer = {
    id: 'm',
    name: 'Maintainer',
    role: 'maintainer',
    workspaceIds: ['app'],
    source: 'team-token'
  };
  assert.throws(() => authorizeToolCall({
    name: 'run_command',
    annotations: { destructiveHint: true },
    args: { workspaceId: 'app', command: 'git reset --hard' },
    config: current,
    principal: maintainer
  }), /high-risk/);
  assert.throws(() => authorizeToolCall({
    name: 'git_push',
    annotations: { destructiveHint: true },
    args: { workspaceId: 'app', forceWithLease: true },
    config: current,
    principal: maintainer
  }), /Force push/);
});

test('resolves unique workspace names to stable scoped workspace ids', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const developer = {
    id: 'd',
    name: 'Dev',
    role: 'developer',
    workspaceIds: ['app'],
    source: 'team-token'
  };
  assert.equal(authorizeToolCall({
    name: 'read_file',
    annotations: { readOnlyHint: true },
    args: { workspaceId: 'Application' },
    config: current,
    principal: developer
  }).workspaceId, 'app');
});

test('classifies queue and Runner tools without assigning the active workspace implicitly', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  assert.equal(requiredCapabilityForTool('job_submit', { destructiveHint: true }, {}), 'validate');
  assert.equal(requiredCapabilityForTool('job_cancel', { destructiveHint: true }, {}), 'write');
  assert.equal(requiredCapabilityForTool('job_runtime_configure', { destructiveHint: true }, {}), 'admin');
  assert.equal(requiredCapabilityForTool('runner_control_status', { readOnlyHint: true }, {}), 'read');
  assert.equal(requiredCapabilityForTool('runner_control_configure', { destructiveHint: true }, {}), 'admin');
  assert.equal(requiredCapabilityForTool('runner_credential_create', { destructiveHint: true }, {}), 'admin');
  assert.equal(toolWorkspaceId('job_submit', { workspaceId: 'app' }, current), null);
  assert.equal(toolWorkspaceId('deployment_drain_start', {}, current), null);
  assert.equal(toolWorkspaceId('runner_control_status', {}, current), null);
  assert.equal(toolWorkspaceId('runner_credential_create', { workspaceId: 'app' }, current), null);
});

test('reserves Runner credential administration for owner', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const maintainer = {
    id: 'm',
    name: 'Maintainer',
    role: 'maintainer',
    workspaceIds: ['app'],
    source: 'team-token'
  };
  assert.throws(() => authorizeToolCall({
    name: 'runner_credential_create',
    annotations: { destructiveHint: true },
    args: { workspaceIds: ['app'] },
    config: current,
    principal: maintainer
  }), /owner role/);
});
