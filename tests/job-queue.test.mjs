import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-jobs-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
const config = configStore.newInstanceConfig({ workspaceRoot: workspace, port: 8787, appVersion: configStore.DEFAULT_VERSION });
config.instanceId = 'job-tests';
config.activeWorkspaceId = 'app';
config.workspaces = [{ id: 'app', name: 'app', root: workspace, mode: 'workspace-write', reference: false }];
config.permissions.profile = 'fullAccess';
config.team.requireWorkspaceLeaseForWrites = true;
config.runtime.maxConcurrentJobs = 2;
await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const queue = await import('../gateway/job-queue.mjs');
const durable = await import('../gateway/durable-state.mjs');

const alice = { id: 'alice', name: 'Alice', role: 'developer', source: 'oauth-member', authVersion: 4, workspaceIds: ['app'] };
const owner = { id: 'local-owner', name: 'Owner', role: 'owner', source: 'local', workspaceIds: [] };

test.beforeEach(() => {
  durable.resetDurableStateForTests();
  queue.clearJobsForTests();
});

test('persists, claims, and completes a capability-matched job with current requester identity', () => {
  const submitted = queue.createJob({
    principal: alice,
    tool: 'run_smart_checks',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core'],
    artifactPaths: ['artifacts/report.json']
  });
  assert.equal(submitted.requestedBy.source, 'oauth-member');
  assert.equal(submitted.requestedBy.authVersion, 4);
  assert.equal(Object.hasOwn(submitted.requestedBy, 'tokenVersion'), false);
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

test('drain blocks new OAuth-member jobs but preserves local owner recovery', () => {
  queue.startDrain({ principal: owner, reason: 'upgrade' });
  assert.throws(() => queue.createJob({ principal: alice, tool: 'run_smart_checks', args: {}, workspaceId: 'app', requiredCapabilities: ['core'] }), /draining/);
  const recovery = queue.createJob({ principal: owner, tool: 'project_snapshot', args: { workspaceId: 'app' }, workspaceId: 'app', requiredCapabilities: ['core'] });
  assert.equal(recovery.status, 'queued');
  assert.equal(queue.claimJob({ runnerId: queue.registerRunner({ id: 'runner-owner', capabilities: ['core'], workspaceIds: ['app'] }).id }), null);
  assert.equal(queue.cancelDrain({ principal: owner }).cancelled, true);
});

test.after(async () => fsp.rm(root, { recursive: true, force: true }));
