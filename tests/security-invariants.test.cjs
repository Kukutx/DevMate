'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const configStore = require('../shared/config-store.cjs');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('legacy MCP token transport is absent', () => {
  const source = read('gateway/server.mjs');
  assert.doesNotMatch(source, /x-devmate-token/);
  assert.doesNotMatch(source, /searchParams\.get\('token'\)/);
});

test('credential rotation does not implicitly reactivate revoked identities', async () => {
  const teamAccess = await import('../gateway/team-access.mjs');
  const runnerAccess = await import('../gateway/runner-access.mjs');
  const config = configStore.newInstanceConfig({ workspaceRoot: root, appVersion: configStore.DEFAULT_VERSION });
  const workspaceId = config.activeWorkspaceId;

  const member = teamAccess.createTeamMember(config, {
    id: 'revoked-member',
    name: 'Revoked member',
    role: 'developer',
    workspaceIds: [workspaceId]
  });
  teamAccess.revokeTeamMember(config, member.member.id);
  const rotatedMember = teamAccess.rotateTeamMemberLoginCode(config, member.member.id);
  assert.equal(rotatedMember.member.disabled, true);
  assert.equal(teamAccess.verifyMemberLoginCode(rotatedMember.loginCode, config), null);

  const runner = runnerAccess.createRunnerCredential(config, {
    id: 'revoked-runner',
    name: 'Revoked runner',
    workspaceIds: [workspaceId],
    capabilities: ['core', 'external']
  });
  runnerAccess.revokeRunnerCredential(config, runner.credential.id);
  const rotatedRunner = runnerAccess.rotateRunnerCredentialToken(config, runner.credential.id);
  assert.equal(rotatedRunner.credential.disabled, true);
  assert.equal(runnerAccess.verifyRunnerToken(rotatedRunner.token, config), null);
});

test('workspace resolution is ID-first and rejects ambiguous names', async () => {
  const { resolveWorkspace } = await import('../gateway/workspace-resolver.mjs');
  const config = {
    activeWorkspaceId: 'primary',
    workspaces: [
      { id: 'primary', name: 'shared', root: '/one' },
      { id: 'secondary', name: 'shared', root: '/two' },
      { id: 'shared', name: 'different', root: '/three' }
    ]
  };
  assert.equal(resolveWorkspace(config, 'shared').id, 'shared');
  assert.throws(() => resolveWorkspace({ ...config, workspaces: config.workspaces.slice(0, 2) }, 'shared'), error => error?.code === 'workspace_ambiguous');
});

test('Runner API matching is version-boundary safe', () => {
  const source = read('gateway/runner-control-plane.mjs');
  assert.match(source, /url\.pathname !== PREFIX && !url\.pathname\.startsWith\(`\$\{PREFIX\}\//);
  assert.doesNotMatch(source, /if \(!url\?\.pathname\.startsWith\(PREFIX\)\)/);
});

test('Host allowlisting is explicit and loopback spoofing always fails closed', async () => {
  const { hostAllowed } = await import('../gateway/http-host-policy.mjs');
  const publicRequest = host => ({ headers: { host }, socket: { remoteAddress: '203.0.113.10' } });
  const localRequest = host => ({ headers: { host }, socket: { remoteAddress: '127.0.0.1' } });
  assert.equal(hostAllowed(publicRequest('devmate.example.com'), { requestPolicy: { allowedHosts: [] } }), true);
  const restricted = { requestPolicy: { allowedHosts: ['devmate.example.com'] } };
  assert.equal(hostAllowed(publicRequest('devmate.example.com'), restricted), true);
  assert.equal(hostAllowed(publicRequest('evil.example.com'), restricted), false);
  assert.equal(hostAllowed(localRequest('127.0.0.1:8787'), restricted), true);
  assert.equal(hostAllowed(publicRequest('localhost:8787'), restricted), false);
});

test('explicit invalid config and durable-state versions are rejected', () => {
  assert.match(read('shared/config-store.cjs'), /invalid_config_version/);
  assert.match(read('gateway/durable-state.mjs'), /invalid_state_version/);
});
