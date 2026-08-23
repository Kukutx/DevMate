import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-external-hold-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const team = await import('../gateway/team-access.mjs');
const durable = await import('../gateway/durable-state.mjs');
const leases = await import('../gateway/workspace-leases.mjs');
const externalHolds = await import('../gateway/external-job-workspace-holds.mjs');
const claims = await import('../gateway/runner-claim-fencing.mjs');
const runtime = await import('../gateway/job-runtime.mjs');
const { preflightQueuedJob } = await import('../gateway/job-preflight.mjs');

function buildConfig() {
  const config = configStore.newInstanceConfig({ workspaceRoot: workspace, appVersion: configStore.DEFAULT_VERSION });
  config.permissions.profile = 'fullAccess';
  config.activeWorkspaceId = 'app';
  config.workspaces = [{ id: 'app', name: 'Application', root: workspace, reference: false, mode: 'workspace-write', role: 'active' }];
  config.team.requireWorkspaceLeaseForWrites = true;
  const created = team.createTeamMember(config, { id: 'alice', name: 'Alice', role: 'developer', workspaceIds: ['app'] });
  const alice = team.verifyMemberLoginCode(created.loginCode, config);
  assert.ok(alice);
  configStore.atomicWriteJson(configPath, team.normalizeInstanceConfig(config));
  return alice;
}

function externalJob(alice, id) {
  return {
    id,
    runnerId: 'runner-a',
    tool: 'run_smart_checks',
    arguments: { workspaceId: 'app' },
    requestedBy: alice,
    timeoutMs: 120_000
  };
}

function issue(job) {
  return claims.issueRunnerClaim({
    jobId: job.id,
    runnerId: job.runnerId,
    leaseExpiresAt: new Date(Date.now() + 90_000).toISOString()
  });
}

test.beforeEach(() => {
  durable.resetDurableStateForTests();
  leases.clearWorkspaceLeases();
  externalHolds.clearExternalJobWorkspaceHoldsForTests();
  claims.clearRunnerClaimsForTests();
  const alice = buildConfig();
  runtime.registerJobTarget('run_smart_checks', {
    title: 'Run smart checks',
    description: 'Test target',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async () => ({ structuredContent: { ok: true }, content: [] }));
  leases.acquireWorkspaceLease({ workspaceId: 'app', principal: alice, ttlSeconds: 120 });
});

test('external preflight automatically holds the requester workspace until claim consumption', () => {
  const config = team.normalizeInstanceConfig(configStore.readJson(configPath, null, { strict: true }));
  const alice = team.principalFromOAuthClaims({ sub: 'member:alice', av: config.team.members[0].authVersion }, config);
  assert.ok(alice);
  const job = externalJob(alice, 'job-external-complete');
  const proof = issue(job);

  const result = preflightQueuedJob(job);
  assert.ok(result.leaseHold, 'external claim must automatically acquire an operation hold');
  assert.equal(leases.workspaceLease('app').activeOperations, 1);
  assert.equal(externalHolds.externalJobWorkspaceHold(job.id)?.runnerId, 'runner-a');
  assert.throws(
    () => leases.releaseWorkspaceLease({ workspaceId: 'app', principal: alice }),
    error => error?.code === 'workspace_lease_active_operations'
  );

  const consumed = claims.consumeRunnerClaim({
    jobId: job.id,
    runnerId: job.runnerId,
    generation: proof.generation,
    token: proof.token
  });
  assert.equal(consumed.workspaceHoldReleased, true);
  assert.equal(externalHolds.externalJobWorkspaceHold(job.id), null);
  assert.equal(leases.workspaceLease('app').activeOperations, 0);
  assert.equal(leases.releaseWorkspaceLease({ workspaceId: 'app', principal: alice }).released, true);
});

test('revoking an external claim releases its durable workspace hold', () => {
  const config = team.normalizeInstanceConfig(configStore.readJson(configPath, null, { strict: true }));
  const alice = team.principalFromOAuthClaims({ sub: 'member:alice', av: config.team.members[0].authVersion }, config);
  const job = externalJob(alice, 'job-external-revoke');
  issue(job);
  preflightQueuedJob(job);
  assert.equal(leases.workspaceLease('app').activeOperations, 1);
  assert.ok(externalHolds.externalJobWorkspaceHold(job.id));

  assert.equal(claims.revokeRunnerClaim(job.id), true);
  assert.equal(externalHolds.externalJobWorkspaceHold(job.id), null);
  assert.equal(leases.workspaceLease('app').activeOperations, 0);
});

test.after(async () => {
  try { leases.clearWorkspaceLeases(); } catch {}
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(root, { recursive: true, force: true });
});
