import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runner-startup-order-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });

const config = configStore.newInstanceConfig({
  workspaceRoot: workspace,
  port: 8787,
  appVersion: configStore.DEFAULT_VERSION
});
config.instanceId = 'runner-startup-order';
config.permissions.profile = 'fullAccess';
config.runtime.maxConcurrentJobs = 1;
config.jobs.embeddedRunnerEnabled = true;
config.jobs.allowJobGitSave = true;
config.activeWorkspaceId = 'app';
config.workspaces = [{ id: 'app', name: 'app', root: workspace, mode: 'workspace-write', reference: false }];
config.plugins = { enabled: [], settings: {} };
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const { installEmbeddedRunnerCapability } = await import('../gateway/embedded-runner-capability.mjs');
const { registerServerInitializer } = await import('../gateway/server-extension-host.mjs');
const { createJob, getJob, clearJobsForTests } = await import('../gateway/job-queue.mjs');
const { jobRuntimeStatus, registerJobTarget, shutdownJobRuntime } = await import('../gateway/job-runtime.mjs');
const { resetDurableStateForTests } = await import('../gateway/durable-state.mjs');

class MockServer {
  async connect() { return 'connected'; }
  registerTool() { return null; }
}

registerServerInitializer(MockServer, {
  id: 'test.reviewed-targets',
  order: 10,
  initialize() {
    registerJobTarget('run_smart_checks', {
      title: 'Run smart checks',
      description: 'startup-order target',
      annotations: { readOnlyHint: false, destructiveHint: true }
    }, async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { ok: true }
    }));
  }
});
installEmbeddedRunnerCapability(MockServer);

test('embedded Runner cannot consume queued work before reviewed targets are initialized', async () => {
  resetDurableStateForTests();
  clearJobsForTests();
  assert.equal(jobRuntimeStatus().started, false);

  const job = createJob({
    principal: { id: 'owner', name: 'Owner', role: 'owner', source: 'local', workspaceIds: ['app'] },
    tool: 'run_smart_checks',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: []
  });

  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(getJob(job.id).attempts, 0, 'queued job was touched before server capabilities initialized');

  const server = new MockServer();
  await server.connect();
  assert.equal(jobRuntimeStatus().started, true);

  for (let attempt = 0; attempt < 150; attempt += 1) {
    const current = getJob(job.id, { includeResult: true });
    if (current.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  const completed = getJob(job.id, { includeResult: true });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.attempts, 1);
  assert.equal(completed.result.structuredContent.ok, true);
});

test.after(async () => {
  await shutdownJobRuntime();
  clearJobsForTests();
  await fsp.rm(root, { recursive: true, force: true });
});
