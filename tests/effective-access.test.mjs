import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAccessSnapshot } from '../gateway/effective-access.mjs';

function config({ profile = 'fullAccess', leaseRequired = false } = {}) {
  return {
    permissions: {
      profile,
      readOnly: profile === 'readOnly',
      blockDangerousOperations: true,
      confirmBeforePush: false,
      allowDirectoryMutations: false
    },
    hostRuntime: { permissionPolicyInitialized: true, permissionPolicyGeneration: 7 },
    auth: { mode: 'oauth' },
    connection: { provider: 'ngrok', publicUrl: '', policyGeneration: 0 },
    team: {
      members: [],
      requireWorkspaceLeaseForWrites: leaseRequired,
      defaultMemberRole: 'developer',
      maxMembers: 100
    },
    requestPolicy: {
      maxRequestBytes: 2097152,
      requestsPerMinute: 600,
      maxConcurrentRequests: 64,
      maxConcurrentPerPrincipal: 16,
      requestTimeoutMs: 900000,
      allowedHosts: []
    },
    runtime: { defaultCommandTimeoutMs: 180000, maxConcurrentJobs: 2 },
    jobs: { embeddedRunnerEnabled: false, allowJobGitSave: true },
    agent: { codexCollaborationEnabled: false }
  };
}

function workspace(overrides = {}) {
  return {
    id: 'app',
    name: 'Application',
    root: '/not-exposed-by-snapshot',
    mode: 'workspace-write',
    reference: false,
    role: 'active',
    ...overrides
  };
}

function principal(overrides = {}) {
  return {
    id: 'local-owner',
    name: 'Local owner',
    role: 'owner',
    source: 'local',
    workspaceIds: [],
    ...overrides
  };
}

function blockerCodes(snapshot, capability = 'write') {
  return snapshot.capabilities[capability].blockers.map(item => item.code);
}

test('fullAccess local owner on writable workspace has effective write access', () => {
  const snapshot = effectiveAccessSnapshot({
    config: config(),
    principal: principal(),
    workspace: workspace(),
    binding: { workspaceId: 'app', name: 'Application', mode: 'workspace-write', source: 'default', implicit: true },
    lease: null
  });
  assert.equal(snapshot.permissionPolicy.profile, 'fullAccess');
  assert.equal(snapshot.permissionPolicy.generation, 7);
  assert.equal(snapshot.capabilities.write.allowed, true);
  assert.equal(snapshot.capabilities.execute.allowed, true);
  assert.equal(snapshot.capabilities.git.allowed, true);
  assert.equal(snapshot.capabilities.publish.allowed, true);
  assert.equal(snapshot.workspace.root, undefined);
  assert.equal(snapshot.conversationBinding.root, undefined);
});

test('fullAccess does not hide OAuth role capability blockers', () => {
  const snapshot = effectiveAccessSnapshot({
    config: config(),
    principal: principal({ id: 'reviewer', role: 'reviewer', source: 'oauth-member', workspaceIds: ['app'] }),
    workspace: workspace(),
    lease: null
  });
  assert.equal(snapshot.capabilities.read.allowed, true);
  assert.equal(snapshot.capabilities.validate.allowed, true);
  assert.equal(snapshot.capabilities.write.allowed, false);
  assert.ok(blockerCodes(snapshot).includes('role_capability_missing'));
});

test('readonly workspace is reported independently from fullAccess', () => {
  const snapshot = effectiveAccessSnapshot({
    config: config(),
    principal: principal({ id: 'developer', role: 'developer', source: 'oauth-member', workspaceIds: ['app'] }),
    workspace: workspace({ mode: 'readonly', reference: true }),
    lease: null
  });
  assert.equal(snapshot.capabilities.write.allowed, false);
  assert.ok(blockerCodes(snapshot).includes('workspace_readonly'));
});

test('remote mutation reports missing and foreign workspace leases precisely', () => {
  const current = config({ leaseRequired: true });
  const developer = principal({ id: 'developer', role: 'developer', source: 'oauth-member', workspaceIds: ['app'] });
  const noLease = effectiveAccessSnapshot({ config: current, principal: developer, workspace: workspace(), lease: null });
  assert.ok(blockerCodes(noLease).includes('workspace_lease_required'));
  assert.ok(blockerCodes(noLease, 'execute').includes('workspace_lease_required'));

  const foreign = effectiveAccessSnapshot({
    config: current,
    principal: developer,
    workspace: workspace(),
    lease: { id: 'lease-1', workspaceId: 'app', principalId: 'other', principalName: 'Other', expiresAt: new Date(Date.now() + 60000).toISOString() }
  });
  assert.ok(blockerCodes(foreign).includes('workspace_leased_by_other'));

  const owned = effectiveAccessSnapshot({
    config: current,
    principal: developer,
    workspace: workspace(),
    lease: { id: 'lease-2', workspaceId: 'app', principalId: 'developer', principalName: 'Developer', expiresAt: new Date(Date.now() + 60000).toISOString() }
  });
  assert.equal(owned.capabilities.write.allowed, true);
  assert.equal(owned.capabilities.execute.allowed, true);
});

test('member workspace scope and readOnly profile are separate blockers', () => {
  const outOfScope = effectiveAccessSnapshot({
    config: config(),
    principal: principal({ id: 'developer', role: 'developer', source: 'oauth-member', workspaceIds: ['other'] }),
    workspace: workspace(),
    lease: null
  });
  assert.ok(blockerCodes(outOfScope, 'read').includes('principal_workspace_scope'));
  assert.ok(blockerCodes(outOfScope).includes('principal_workspace_scope'));

  const readOnly = effectiveAccessSnapshot({
    config: config({ profile: 'readOnly' }),
    principal: principal(),
    workspace: workspace(),
    lease: null
  });
  assert.equal(readOnly.capabilities.read.allowed, true);
  assert.equal(readOnly.capabilities.write.allowed, false);
  assert.ok(blockerCodes(readOnly).includes('permission_profile_readonly'));
});

test('balanced policy reports conditional guards without pretending all writes are blocked', () => {
  const snapshot = effectiveAccessSnapshot({
    config: config({ profile: 'balanced' }),
    principal: principal(),
    workspace: workspace(),
    lease: null
  });
  assert.equal(snapshot.capabilities.write.allowed, true);
  assert.equal(snapshot.conditionalGuards.dangerousOperationsGuarded, true);
  assert.equal(snapshot.conditionalGuards.directoryMutationsAllowed, false);
});
