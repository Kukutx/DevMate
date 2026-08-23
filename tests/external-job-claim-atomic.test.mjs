import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-atomic-claim-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(configPath, JSON.stringify({
  appVersion: '2.9.2',
  instanceId: 'atomic-claim-tests',
  auth: { required: true, token: 'owner-token-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'team' },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: false },
  production: {},
  runtime: { maxConcurrentJobs: 2 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', root: workspace, mode: 'workspace-write', reference: false }]
}, null, 2));
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const durable = await import('../gateway/durable-state.mjs');
const queue = await import('../gateway/job-queue.mjs');
const { claimExternalJob } = await import('../gateway/external-job-claim.mjs');

const principal = { id: 'alice', name: 'Alice', role: 'developer', source: 'team-token', workspaceIds: ['app'] };

function submitAndRegister() {
  const submitted = queue.createJob({
    principal,
    tool: 'project_snapshot',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core']
  });
  queue.registerRunner({ id: 'runner-a', capabilities: ['core'], workspaceIds: ['app'] });
  return submitted;
}

test.beforeEach(() => {
  durable.resetDurableStateForTests();
  queue.clearJobsForTests();
});

test('persists Job ownership and claim proof in one durable document update', () => {
  const submitted = submitAndRegister();
  const claimed = claimExternalJob({ runnerId: 'runner-a', leaseSeconds: 60 });
  assert.equal(claimed.job.id, submitted.id);
  assert.equal(claimed.job.status, 'running');
  assert.equal(claimed.claim.generation, 1);
  assert.match(claimed.claim.token, /^[A-Za-z0-9_-]{43}$/);

  durable.resetDurableStateForTests();
  const jobs = durable.readDurableNamespace('jobs', null);
  const claims = durable.readDurableNamespace('runner-claims', null);
  const storedJob = jobs.jobs.find(item => item.id === submitted.id);
  assert.equal(storedJob.runnerId, 'runner-a');
  assert.equal(storedJob.status, 'running');
  assert.equal(claims.claims[submitted.id].runnerId, 'runner-a');
  assert.equal(claims.claims[submitted.id].generation, 1);
  assert.equal(claims.claims[submitted.id].token, undefined);
  assert.notEqual(claims.claims[submitted.id].tokenHash, claimed.claim.token);
});

test('retains monotonically increasing generations across retries', () => {
  const submitted = queue.createJob({
    principal,
    tool: 'project_snapshot',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core'],
    maxAttempts: 3
  });
  queue.registerRunner({ id: 'runner-a', capabilities: ['core'], workspaceIds: ['app'] });
  const first = claimExternalJob({ runnerId: 'runner-a' });
  queue.failJob({ id: submitted.id, runnerId: 'runner-a', error: 'retry', retryable: true });
  durable.mutateDurableDocument(document => {
    const job = document.namespaces.jobs.jobs.find(item => item.id === submitted.id);
    job.nextRunAt = new Date(0).toISOString();
  });
  const second = claimExternalJob({ runnerId: 'runner-a' });
  assert.equal(first.claim.generation, 1);
  assert.equal(second.claim.generation, 2);
  assert.notEqual(first.claim.token, second.claim.token);
});

test('malformed Job state cannot disable drain or be normalized during an external claim', () => {
  const submitted = submitAndRegister();
  durable.mutateDurableDocument(document => {
    document.namespaces.jobs.drain.active = 'yes';
  });
  durable.resetDurableStateForTests();
  assert.throws(
    () => claimExternalJob({ runnerId: 'runner-a' }),
    error => error?.code === 'external_job_claim_state_invalid'
  );
  durable.resetDurableStateForTests();
  const stored = durable.readDurableNamespace('jobs', null);
  assert.equal(stored.drain.active, 'yes');
  assert.equal(stored.jobs.find(item => item.id === submitted.id).status, 'queued');
});

test('malformed Runner claim state aborts the entire external claim mutation', () => {
  const submitted = submitAndRegister();
  const malformed = { version: 1, claims: {}, generations: null };
  durable.writeDurableNamespace('runner-claims', malformed);
  durable.resetDurableStateForTests();
  assert.throws(
    () => claimExternalJob({ runnerId: 'runner-a' }),
    error => error?.code === 'runner_claim_state_invalid'
  );
  durable.resetDurableStateForTests();
  assert.deepEqual(durable.readDurableNamespace('runner-claims', null), malformed);
  const stored = durable.readDurableNamespace('jobs', null).jobs.find(item => item.id === submitted.id);
  assert.equal(stored.status, 'queued');
  assert.equal(stored.runnerId, null);
});

test('does not persist partial durable mutations when the mutator throws', () => {
  durable.writeDurableNamespace('marker', { before: true });
  assert.throws(() => durable.mutateDurableDocument(document => {
    document.namespaces.marker = { after: true };
    throw new Error('stop');
  }), /stop/);
  durable.resetDurableStateForTests();
  assert.deepEqual(durable.readDurableNamespace('marker', null), { before: true });
});

test.after(async () => fsp.rm(root, { recursive: true, force: true }));