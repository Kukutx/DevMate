import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __test, authorizeToolCall, createTeamMember, normalizeInstanceConfig, requiredCapabilityForTool,
  revokeTeamMember, rotateTeamMemberToken, toolWorkspaceId, updateTeamMember, verifyAccessToken
} from '../gateway/team-access.mjs';

function config() {
  return {
    auth: { required: true, token: 'owner-secret-token-value' },
    permissions: { profile: 'fullAccess' },
    connection: { provider: 'ngrok', publicUrl: '' },
    team: { members: [], requireWorkspaceLeaseForWrites: false },
    requestPolicy: {}, runtime: {}, jobs: {},
    activeWorkspaceId: 'app',
    workspaces: [{ id: 'app', name: 'Application', reference: false, mode: 'workspace-write' }]
  };
}

test('parses fixed-length member secrets without confusing underscores', () => {
  const secret = `${'a'.repeat(20)}_${'b'.repeat(22)}`;
  assert.deepEqual(__test.parseTeamToken(`dmt_data_ops_${secret}`), { id: 'data_ops', secret });
});

test('creates hashed team tokens and verifies scoped principals', () => {
  const current = normalizeInstanceConfig(config());
  const created = createTeamMember(current, { id: 'data_ops', name: 'Alice', role: 'developer', workspaceIds: ['app'] });
  assert.match(created.token, /^dmt_/);
  assert.equal(current.team.members[0].tokenHash.includes(created.token), false);
  assert.deepEqual(verifyAccessToken(created.token, current).workspaceIds, ['app']);
});

test('rotating a revoked Team token does not reactivate the member', () => {
  const current = normalizeInstanceConfig(config());
  const created = createTeamMember(current, { id: 'revoked-member', name: 'Revoked member', role: 'developer', workspaceIds: ['app'] });
  revokeTeamMember(current, created.member.id);
  const rotated = rotateTeamMemberToken(current, created.member.id);
  assert.equal(rotated.member.disabled, true);
  assert.equal(verifyAccessToken(rotated.token, current), null);
  updateTeamMember(current, created.member.id, { disabled: false });
  assert.equal(verifyAccessToken(rotated.token, current)?.id, created.member.id);
});

test('rejects empty Team workspace scopes', () => {
  const current = normalizeInstanceConfig(config());
  assert.throws(() => createTeamMember(current, { name: 'Unscoped', role: 'developer', workspaceIds: [] }), /at least one explicit workspace ID/);
});

test('enforces role capabilities and workspace scopes', () => {
  const current = normalizeInstanceConfig(config());
  current.workspaces.push({ id: 'other', name: 'Other', reference: false, mode: 'workspace-write' });
  const reviewer = { id: 'r', name: 'Reviewer', role: 'reviewer', workspaceIds: ['app'], source: 'team-token' };
  assert.equal(authorizeToolCall({ name: 'godot_validate', annotations: { destructiveHint: true }, args: { workspaceId: 'app' }, config: current, principal: reviewer }).capability, 'validate');
  assert.throws(() => authorizeToolCall({ name: 'write_file', annotations: { destructiveHint: true }, args: { workspaceId: 'app' }, config: current, principal: reviewer }), /cannot use/);
  assert.throws(() => authorizeToolCall({ name: 'read_file', annotations: { readOnlyHint: true }, args: { workspaceId: 'other' }, config: current, principal: reviewer }), /not allowed to access workspace other/);
});

test('configured and project commands require execute authorization', () => {
  const current = normalizeInstanceConfig(config());
  const reviewer = { id: 'r', name: 'Reviewer', role: 'reviewer', workspaceIds: ['app'], source: 'team-token' };
  const developer = { id: 'd', name: 'Developer', role: 'developer', workspaceIds: ['app'], source: 'team-token' };
  for (const name of ['run_configured_command', 'run_project_script']) {
    const request = { name, annotations: { destructiveHint: true }, args: { workspaceId: 'app' }, config: current };
    assert.throws(() => authorizeToolCall({ ...request, principal: reviewer }), /required capability: execute/, name);
    assert.equal(authorizeToolCall({ ...request, principal: developer }).capability, 'execute', name);
  }
});

test('OAuth owner principal remains unrestricted by member workspace scopes', () => {
  const current = normalizeInstanceConfig(config());
  current.workspaces.push({ id: 'other', name: 'Other', reference: false, mode: 'workspace-write' });
  const principal = { id: 'owner', name: 'OAuth owner', role: 'owner', workspaceIds: [], source: 'oauth' };
  assert.equal(principal.role, 'owner');
  assert.equal(authorizeToolCall({ name: 'read_file', annotations: { readOnlyHint: true }, args: { workspaceId: 'other' }, config: current, principal }).workspaceId, 'other');
});

test('blocks high-risk operations for member tokens even under full local access', () => {
  const current = normalizeInstanceConfig(config());
  const maintainer = { id: 'm', name: 'Maintainer', role: 'maintainer', workspaceIds: ['app'], source: 'team-token' };
  assert.throws(() => authorizeToolCall({ name: 'run_command', annotations: { destructiveHint: true }, args: { workspaceId: 'app', command: 'git reset --hard' }, config: current, principal: maintainer }), /high-risk/);
  assert.throws(() => authorizeToolCall({ name: 'git_push', annotations: { destructiveHint: true }, args: { workspaceId: 'app', forceWithLease: true }, config: current, principal: maintainer }), /Force push/);
});

test('structured Git fields cannot smuggle options or force refspecs for Team tokens', () => {
  const current = normalizeInstanceConfig(config());
  const maintainer = { id: 'm', name: 'Maintainer', role: 'maintainer', workspaceIds: ['app'], source: 'team-token' };
  const base = { annotations: { destructiveHint: true }, config: current, principal: maintainer };
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'git_push', args: { workspaceId: 'app', remote: '--force', branch: 'main' } }),
    /cannot smuggle options or force refspecs/
  );
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'git_push', args: { workspaceId: 'app', remote: 'origin', branch: '+main' } }),
    /cannot smuggle options or force refspecs/
  );
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'git_save', args: { workspaceId: 'app', push: true, remote: 'origin', branch: '+main' } }),
    /cannot smuggle options or force refspecs/
  );
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'git_pull', args: { workspaceId: 'app', remote: '--rebase', branch: 'main' } }),
    /cannot smuggle options or force refspecs/
  );
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'git_checkout', args: { workspaceId: 'app', branch: '--detach' } }),
    /checkout targets cannot be option-like/
  );
  assert.equal(
    authorizeToolCall({ ...base, name: 'git_push', args: { workspaceId: 'app', remote: 'origin', branch: 'main' } }).capability,
    'publish'
  );
});

test('structured operand safety also applies to owner calls and package scripts', () => {
  const current = normalizeInstanceConfig(config());
  const owner = { id: 'owner', name: 'Owner', role: 'owner', workspaceIds: [], source: 'oauth' };
  const base = { annotations: { destructiveHint: true }, config: current, principal: owner };
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'git_push', args: { workspaceId: 'app', remote: '--force', branch: 'main' } }),
    /cannot smuggle options or force refspecs/
  );
  assert.throws(
    () => authorizeToolCall({ ...base, name: 'run_project_script', args: { workspaceId: 'app', script: 'test; echo injected' } }),
    /option-safe package script identifier/
  );
  assert.equal(
    authorizeToolCall({ ...base, name: 'run_project_script', args: { workspaceId: 'app', script: 'test:e2e' } }).capability,
    'execute'
  );
});

test('classifies queue and Runner administration without implicit workspace scope', () => {
  const current = normalizeInstanceConfig(config());
  assert.equal(requiredCapabilityForTool('job_submit', { destructiveHint: true }, {}), 'validate');
  assert.equal(requiredCapabilityForTool('job_cancel', { destructiveHint: true }, {}), 'write');
  assert.equal(requiredCapabilityForTool('runner_credential_create', { destructiveHint: true }, {}), 'admin');
  assert.equal(toolWorkspaceId('job_submit', { workspaceId: 'app' }, current), null);
  assert.equal(toolWorkspaceId('runner_credential_create', { workspaceId: 'app' }, current), null);
});