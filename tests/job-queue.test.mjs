import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-jobs-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(configPath, JSON.stringify({
  appVersion: '2.2.0',
  instanceId: 'job-tests',
  auth: { required: true, token: 'owner-token-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'team' },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: true },
  production: {},
  runtime: { maxConcurrentJobs: 2 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'app', root: workspace, mode: 'workspace-write', reference: false }]
}, null, 2));
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const queue = await import('../gateway/job-queue.mjs');
const durable = await import('../gateway/durable-state.mjs');

const alice = { id: 'alice', name: 'Alice', role: 'developer', source: 'team-token', workspaceIds: ['app'] };
const owner = { id: 'personal-owner', name: 'Owner', role: 'owner', source: 'personal-token', workspaceIds: [] };

test.beforeEach(() => {
  durable.resetDurableStateForTests();
  queue.clearJobsForTests();
});

test('persists, claims, and completes a capability-matched job', () => {
  const submitted = queue.createJob({
    principal: alice,
    tool: 'run_smart_checks',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core'],
    artifactPaths: ['artifacts/report.json']
  });
  queue.registerRunner({ id: 'runner-a', capabilities: ['core'], workspaceIds: ['app'], maxConcurrent: 1 });
  const claimed = queue.claimJob({ runnerId: 'runner-a' });
  assert.equal(claimed.id, submitted.id);
  assert.equal(claimed.status, 'running');
  const completed = queue.completeJob({ id: submitted.id, runnerId: 'runner-a', result: { ok: true }, artifacts: [{ path: 'artifacts/report.json' }] });
  assert.equal(completed.status, 'succeeded');
  durable.resetDurableStateForTests();
  assert.equal(queue.getJob(submitted.id, { includeResult: true }).result.ok, true);
});

test('rejects credential-bearing durable arguments', () => {
  assert.throws(() => queue.createJob({
    principal: alice,
    tool: 'run_configured_command',
    args: { apiKey: 'secret-value' },
    workspaceId: 'app',
    requiredCapabilities: ['core']
  }), /sensitive field/);
  assert.throws(() => queue.createJob({
    principal: alice,
    tool: 'run_project_script',
    args: { command: 'curl https://example.test?token=abc' },
    workspaceId: 'app',
    requiredCapabilities: ['core']
  }), /credential-like/);
});

test('drain blocks new team jobs but preserves owner recovery', () => {
  queue.startDrain({ principal: owner, reason: 'upgrade' });
  assert.throws(() => queue.createJob({ principal: alice, tool: 'run_smart_checks', args: {}, workspaceId: 'app', requiredCapabilities: ['core'] }), /draining/);
  const recovery = queue.createJob({ principal: owner, tool: 'project_snapshot', args: { workspaceId: 'app' }, workspaceId: 'app', requiredCapabilities: ['core'] });
  assert.equal(recovery.status, 'queued');
  assert.equal(queue.claimJob({ runnerId: queue.registerRunner({ id: 'runner-owner', capabilities: ['core'], workspaceIds: ['app'] }).id }), null);
  assert.equal(queue.cancelDrain({ principal: owner }).cancelled, true);
});

test.after(async () => fsp.rm(root, { recursive: true, force: true }));
