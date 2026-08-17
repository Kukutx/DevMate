import assert from 'node:assert/strict';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';
import {
  authorizeToolCall,
  createTeamMember,
  normalizeInstanceConfig,
  requiredCapabilityForTool,
  revokeTeamMember,
  rotateTeamMemberLoginCode,
  toolWorkspaceId,
  updateTeamMember,
  verifyMemberLoginCode
} from '../gateway/team-access.mjs';

function config() {
  const current = configStore.newInstanceConfig({ workspaceRoot: process.cwd(), appVersion: configStore.DEFAULT_VERSION });
  current.auth = { mode: 'oauth' };
  current.permissions.profile = 'fullAccess';
  current.activeWorkspaceId = 'app';
  current.workspaces = [{ id: 'app', name: 'Application', root: process.cwd(), reference: false, mode: 'workspace-write', role: 'active' }];
  current.team.requireWorkspaceLeaseForWrites = false;
  return normalizeInstanceConfig(current);
}

function memberPrincipal(current, id, role = 'developer', workspaceIds = ['app']) {
  const created = createTeamMember(current, { id, name: id, role, workspaceIds });
  const principal = verifyMemberLoginCode(created.loginCode, current);
  assert.ok(principal);
  return { created, principal };
}

function oauthOwner() {
  return { id: 'oauth-owner', name: 'OAuth owner', role: 'owner', workspaceIds: [], source: 'oauth-owner' };
}

test('current member login codes support underscored IDs and resolve to OAuth member principals', () => {
  const current = config();
  const created = createTeamMember(current, { id: 'data_ops', name: 'Alice', role: 'developer', workspaceIds: ['app'] });
  assert.match(created.loginCode, /^dmc_data_ops_[A-Za-z0-9_-]{43}$/);
  const principal = verifyMemberLoginCode(created.loginCode, current);
  assert.equal(principal.id, 'data_ops');
  assert.equal(principal.source, 'oauth-member');
  assert.equal(principal.authVersion, 1);
});

test('creates hashed member login codes and verifies scoped OAuth principals', () => {
  const current = config();
  const { created, principal } = memberPrincipal(current, 'data_ops');
  assert.equal(current.team.members[0].loginHash.includes(created.loginCode), false);
  assert.equal(current.team.members[0].loginSalt.includes(created.loginCode), false);
  assert.deepEqual(principal.workspaceIds, ['app']);
});

test('rotating a revoked member login code does not reactivate the member and increments authVersion', () => {
  const current = config();
  const { created } = memberPrincipal(current, 'revoked-member');
  revokeTeamMember(current, created.member.id);
  const rotated = rotateTeamMemberLoginCode(current, created.member.id);
  assert.equal(rotated.member.disabled, true);
  assert.equal(rotated.member.authVersion, 2);
  assert.equal(verifyMemberLoginCode(rotated.loginCode, current), null);
  updateTeamMember(current, created.member.id, { disabled: false });
  const reenabled = verifyMemberLoginCode(rotated.loginCode, current);
  assert.equal(reenabled?.id, created.member.id);
  assert.equal(reenabled?.authVersion, 2);
});

test('rejects empty member workspace scopes', () => {
  const current = config();
  assert.throws(() => createTeamMember(current, { name: 'Unscoped', role: 'developer', workspaceIds: [] }), /at least one explicit workspace ID/);
});

test('enforces live role capabilities and workspace scopes for OAuth members', () => {
  const current = config();
  current.workspaces.push({ id: 'other', name: 'Other', root: process.cwd(), reference: false, mode: 'workspace-write' });
  const { principal: reviewer } = memberPrincipal(current, 'reviewer', 'reviewer');
  assert.equal(authorizeToolCall({ name: 'godot_validate', annotations: { destructiveHint: true }, args: { workspaceId: 'app' }, config: current, principal: reviewer }).capability, 'validate');
  assert.throws(() => authorizeToolCall({ name: 'write_file', annotations: { destructiveHint: true }, args: { workspaceId: 'app' }, config: current, principal: reviewer }), /cannot use/);
  assert.throws(() => authorizeToolCall({ name: 'read_file', annotations: { readOnlyHint: true }, args: { workspaceId: 'other' }, config: current, principal: reviewer }), /not allowed to access workspace other/);
});

test('configured and project commands require execute authorization', () => {
  const current = config();
  const { principal: reviewer } = memberPrincipal(current, 'reviewer', 'reviewer');
  const { principal: developer } = memberPrincipal(current, 'developer', 'developer');
  for (const name of ['run_configured_command', 'run_project_script']) {
    const request = { name, annotations: { destructiveHint: true }, args: { workspaceId: 'app' }, config: current };
    assert.throws(() => authorizeToolCall({ ...request, principal: reviewer }), /required capability: execute/, name);
    assert.equal(authorizeToolCall({ ...request, principal: developer }).capability, 'execute', name);
  }
});

test('OAuth owner principal remains unrestricted by member workspace scopes', () => {
  const current = config();
  current.workspaces.push({ id: 'other', name: 'Other', root: process.cwd(), reference: false, mode: 'workspace-write' });
  const principal = oauthOwner();
  assert.equal(authorizeToolCall({ name: 'read_file', annotations: { readOnlyHint: true }, args: { workspaceId: 'other' }, config: current, principal }).workspaceId, 'other');
});

test('blocks high-risk operations for OAuth members even under full local access', () => {
  const current = config();
  const { principal: maintainer } = memberPrincipal(current, 'maintainer', 'maintainer');
  assert.throws(() => authorizeToolCall({ name: 'run_command', annotations: { destructiveHint: true }, args: { workspaceId: 'app', command: 'git reset --hard' }, config: current, principal: maintainer }), /high-risk/);
  assert.throws(() => authorizeToolCall({ name: 'run_command', annotations: { destructiveHint: true }, args: { workspaceId: 'app', command: 'git push origin --mirror' }, config: current, principal: maintainer }), /high-risk/);
  assert.throws(() => authorizeToolCall({ name: 'git_push', annotations: { destructiveHint: true }, args: { workspaceId: 'app', forceWithLease: true }, config: current, principal: maintainer }), /Force push/);
});

test('member shell Git safety blocks force-reset forms but keeps normal branch workflows', () => {
  const current = config();
  const { principal: maintainer } = memberPrincipal(current, 'maintainer', 'maintainer');
  const request = command => authorizeToolCall({
    name: 'run_command',
    annotations: { destructiveHint: true },
    args: { workspaceId: 'app', command },
    config: current,
    principal: maintainer
  });
  for (const command of ['git switch -c feature/safe', 'git checkout -b feature/safe-2', 'git branch -d merged-branch']) {
    assert.equal(request(command).capability, 'execute', command);
  }
  for (const command of ['git switch -C feature/reset', 'git checkout -B feature/reset', 'git branch -D old-branch']) {
    assert.throws(() => request(command), /high-risk/, command);
  }
});

test('structured Git fields cannot smuggle options or destructive refspecs', () => {
  const current = config();
  const { principal: maintainer } = memberPrincipal(current, 'maintainer', 'maintainer');
  const base = { annotations: { destructiveHint: true }, config: current, principal: maintainer };
  for (const args of [
    { workspaceId: 'app', remote: '--force', branch: 'main' },
    { workspaceId: 'app', remote: 'origin', branch: '+main' },
    { workspaceId: 'app', remote: 'origin', branch: ':main' },
    { workspaceId: 'app', remote: 'origin', branch: 'main:other' }
  ]) {
    assert.throws(() => authorizeToolCall({ ...base, name: 'git_push', args }), /cannot smuggle options or force refspecs/);
  }
  assert.throws(() => authorizeToolCall({ ...base, name: 'git_save', args: { workspaceId: 'app', push: true, remote: 'origin', branch: '+main' } }), /cannot smuggle options or force refspecs/);
  assert.throws(() => authorizeToolCall({ ...base, name: 'git_pull', args: { workspaceId: 'app', remote: '--rebase', branch: 'main' } }), /cannot smuggle options or force refspecs/);
  assert.throws(() => authorizeToolCall({ ...base, name: 'git_checkout', args: { workspaceId: 'app', branch: '--detach' } }), /checkout targets cannot be option-like or refspec-like/);
  assert.equal(authorizeToolCall({ ...base, name: 'git_push', args: { workspaceId: 'app', remote: 'origin', branch: 'feature/safe' } }).capability, 'publish');
});

test('member git_raw cannot bypass destructive Git safeguards', () => {
  const current = config();
  const { principal: maintainer } = memberPrincipal(current, 'maintainer', 'maintainer');
  const base = { name: 'git_raw', annotations: { destructiveHint: true }, config: current, principal: maintainer };
  for (const args of [
    ['push', 'origin', '--delete', 'main'], ['push', 'origin', ':main'], ['push', '--mirror', 'origin'], ['push', '--prune', 'origin'],
    ['branch', '-D', 'main'], ['branch', '-f', 'main', 'HEAD~1'], ['branch', '-M', 'main', 'other'], ['restore', '.'],
    ['reset', '--soft', 'HEAD~1'], ['checkout', '--', 'file.txt'], ['checkout', '-f', 'main'], ['checkout', '-B', 'main', 'HEAD~1'],
    ['switch', '--discard-changes', 'main'], ['switch', '-C', 'main', 'HEAD~1']
  ]) {
    assert.throws(() => authorizeToolCall({ ...base, args: { workspaceId: 'app', args } }), /High-risk raw Git operations require the owner role/, args.join(' '));
  }
  for (const args of [['status', '--short'], ['branch', '-d', 'merged-branch'], ['switch', '-c', 'feature/safe'], ['checkout', '-b', 'feature/safe-2']]) {
    assert.equal(authorizeToolCall({ ...base, args: { workspaceId: 'app', args } }).capability, 'git', args.join(' '));
  }
});

test('structured operand safety also applies to owner calls and package scripts', () => {
  const current = config();
  const owner = oauthOwner();
  const base = { annotations: { destructiveHint: true }, config: current, principal: owner };
  assert.throws(() => authorizeToolCall({ ...base, name: 'git_push', args: { workspaceId: 'app', remote: '--force', branch: 'main' } }), /cannot smuggle options or force refspecs/);
  assert.throws(() => authorizeToolCall({ ...base, name: 'run_project_script', args: { workspaceId: 'app', script: 'test; echo injected' } }), /option-safe package script identifier/);
  assert.equal(authorizeToolCall({ ...base, name: 'run_project_script', args: { workspaceId: 'app', script: 'test:e2e' } }).capability, 'execute');
});

test('classifies queue and Runner administration without implicit workspace scope', () => {
  const current = config();
  assert.equal(requiredCapabilityForTool('job_submit', { destructiveHint: true }, {}), 'validate');
  assert.equal(requiredCapabilityForTool('job_cancel', { destructiveHint: true }, {}), 'write');
  assert.equal(requiredCapabilityForTool('runner_credential_create', { destructiveHint: true }, {}), 'admin');
  assert.equal(toolWorkspaceId('job_submit', { workspaceId: 'app' }, current), null);
  assert.equal(toolWorkspaceId('runner_credential_create', { workspaceId: 'app' }, current), null);
});
