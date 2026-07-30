import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authorizeToolCall,
  createTeamMember,
  normalizeDeploymentConfig,
  verifyAccessToken
} from '../gateway/team-access.mjs';

function config() {
  return {
    auth: { required: true, token: 'owner-secret-token-value' },
    permissions: { profile: 'fullAccess' },
    deployment: { mode: 'team' },
    team: { members: [] },
    production: {},
    activeWorkspaceId: 'app'
  };
}

test('creates hashed team tokens and verifies scoped principals', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const created = createTeamMember(current, {
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

test('enforces role capabilities and workspace scopes', () => {
  const current = config();
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
  }), /not allowed/);
});

test('personal owner token remains backwards compatible', () => {
  const current = config();
  normalizeDeploymentConfig(current);
  const principal = verifyAccessToken('owner-secret-token-value', current);
  assert.equal(principal.role, 'owner');
  assert.equal(principal.source, 'personal-token');
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

test('resolves workspace names to scoped workspace ids', () => {
  const current = config();
  current.workspaces = [{ id: 'app', name: 'Application' }];
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
