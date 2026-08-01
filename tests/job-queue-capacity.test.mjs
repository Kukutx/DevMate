import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-job-capacity-'));
const configPath = path.join(root, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({
  instanceId: 'job-capacity-tests',
  permissions: { profile: 'fullAccess' }
}), 'utf8');
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const durable = await import('../gateway/durable-state.mjs');
const limits = await import('../gateway/job-store-limits.mjs');
const queue = await import('../gateway/job-queue.mjs');

function activeJob(index) {
  const time = new Date(Date.now() - index * 1000).toISOString();
  return {
    id: `existing-${index}`,
    title: `Existing ${index}`,
    tool: 'project_snapshot',
    arguments: {},
    workspaceId: 'app',
    requestedBy: { id: 'owner', name: 'Owner', role: 'owner', source: 'local', workspaceIds: [] },
    priority: 50,
    requiredCapabilities: ['core'],
    artifactPaths: [],
    status: 'queued',
    runnerId: null,
    attempts: 0,
    maxAttempts: 2,
    timeoutMs: 1000,
    createdAt: time,
    updatedAt: time,
    startedAt: null,
    finishedAt: null,
    nextRunAt: time,
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    error: null,
    result: null,
    artifacts: [],
    events: []
  };
}

function emptyStore() {
  return {
    version: 1,
    jobs: [],
    runners: [],
    drain: { active: false, startedAt: null, startedBy: null, reason: '' }
  };
}

test.beforeEach(() => {
  durable.resetDurableStateForTests();
  queue.clearJobsForTests();
});

test('rejects a new Job when the active queue reaches its hard limit', () => {
  const store = emptyStore();
  store.jobs = Array.from({ length: limits.MAX_ACTIVE_JOBS }, (_, index) => activeJob(index));
  durable.writeDurableNamespace('jobs', store);
  assert.throws(() => queue.createJob({
    principal: { id: 'owner', role: 'owner', source: 'local' },
    tool: 'project_snapshot',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core']
  }), error => {
    assert.equal(error.code, 'job_queue_capacity');
    assert.match(error.message, /active Job limit/);
    return true;
  });
  assert.equal(queue.jobQueueCapacityStatus().activeJobs, limits.MAX_ACTIVE_JOBS);
});

test('prunes long-offline Runner records during normal reads', () => {
  const store = emptyStore();
  store.runners = [{
    id: 'old-runner',
    name: 'Old runner',
    capabilities: ['core'],
    workspaceIds: ['app'],
    maxConcurrent: 1,
    status: 'offline',
    version: 'old',
    platform: 'linux',
    arch: 'x64',
    labels: {},
    registeredAt: '2025-01-01T00:00:00.000Z',
    lastHeartbeatAt: '2025-01-01T00:00:00.000Z',
    runningJobs: 0
  }];
  durable.writeDurableNamespace('jobs', store);
  assert.deepEqual(queue.listRunners(), []);
  assert.equal(queue.jobQueueCapacityStatus().runners, 0);
});

test.after(async () => fsp.rm(root, { recursive: true, force: true }));
