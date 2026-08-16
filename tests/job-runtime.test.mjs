import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-job-runtime-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(path.join(workspace, 'artifacts'), { recursive: true });
const config = configStore.newInstanceConfig({ workspaceRoot: workspace, port: 8787, appVersion: configStore.DEFAULT_VERSION });
config.instanceId = 'runtime-tests';
config.permissions.profile = 'fullAccess';
config.connection = { provider: 'ngrok', publicUrl: '' };
config.team.requireWorkspaceLeaseForWrites = false;
config.runtime.maxConcurrentJobs = 1;
config.jobs.embeddedRunnerEnabled = true;
config.jobs.allowJobGitSave = true;
config.activeWorkspaceId = 'app';
config.workspaces = [{ id: 'app', name: 'app', root: workspace, mode: 'workspace-write', reference: false }];
config.plugins = { enabled: [], settings: {} };
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const { installTeamCapabilities } = await import('../gateway/team-capabilities.mjs');
const { getJob, clearJobsForTests } = await import('../gateway/job-queue.mjs');
const { __test, jobTargetEnabled, runJobWorkerOnce, shutdownJobRuntime } = await import('../gateway/job-runtime.mjs');
const { resetDurableStateForTests } = await import('../gateway/durable-state.mjs');

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, toolConfig, handler) { this.tools.set(name, { config: toolConfig, handler }); }
  async connect() { return 'connected'; }
}

installTeamCapabilities(MockServer);

test('executes a reviewed target and indexes generated artifact directories', async () => {
  resetDurableStateForTests();
  clearJobsForTests();
  const server = new MockServer();
  server.registerTool('run_smart_checks', {
    title: 'Run smart checks',
    description: 'fake checks',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {}
  }, async ({ workspaceId }) => {
    assert.equal(workspaceId, 'app');
    await fsp.writeFile(path.join(workspace, 'artifacts', 'checks.json'), '{"ok":true}\n', 'utf8');
    await fsp.writeFile(path.join(workspace, 'artifacts', 'screenshot.png'), 'fake-image', 'utf8');
    await fsp.writeFile(path.join(workspace, 'artifacts', 'ignored.log'), 'sensitive log', 'utf8');
    return {
      content: [{ type: 'text', text: 'checks passed' }],
      structuredContent: { ok: true, reportPath: 'artifacts/checks.json' }
    };
  });
  await server.connect();
  const submitted = await server.tools.get('job_submit').handler({
    workspaceId: 'app',
    tool: 'run_smart_checks',
    arguments: { workspaceId: 'app' },
    artifactPaths: ['artifacts']
  });
  const id = submitted.structuredContent.job.id;
  const claimed = await runJobWorkerOnce();
  assert.equal(claimed.id, id);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = getJob(id, { includeResult: true });
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const job = getJob(id, { includeResult: true });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.structuredContent.ok, true);
  const artifactPaths = job.artifacts.map(item => item.path);
  assert.deepEqual(artifactPaths, ['artifacts/checks.json', 'artifacts/screenshot.png']);
  assert.match(job.artifacts[0].sha256, /^[a-f0-9]{64}$/);
});

test('timeout aborts cooperatively but does not settle before the handler', async () => {
  const controller = new AbortController();
  let settled = false;
  const lateHandler = new Promise(resolve => setTimeout(() => {
    settled = true;
    resolve('late result');
  }, 40));
  const started = Date.now();
  await assert.rejects(
    __test.withTimeout(lateHandler, 5, error => controller.abort(error)),
    error => error.code === 'job_timeout'
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(settled, true);
  assert.ok(Date.now() - started >= 30);
});

test('a target disabled after claim does not leak an inflight slot', async () => {
  resetDurableStateForTests();
  clearJobsForTests();
  const server = new MockServer();
  server.registerTool('run_smart_checks', {
    title: 'Run smart checks',
    description: 'temporary target',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {}
  }, async () => ({ content: [{ type: 'text', text: 'unused' }], structuredContent: { ok: true } }));
  await server.connect();
  const submitted = await server.tools.get('job_submit').handler({
    workspaceId: 'app',
    tool: 'run_smart_checks',
    arguments: { workspaceId: 'app' }
  });
  const id = submitted.structuredContent.job.id;
  const savedTarget = __test.targets.get('run_smart_checks');
  try {
    __test.targets.delete('run_smart_checks');
    const claimed = await runJobWorkerOnce();
    assert.equal(claimed.id, id);
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(__test.inflight.has(id), false);
    assert.equal(getJob(id).status, 'queued');
  } finally {
    if (savedTarget) __test.targets.set('run_smart_checks', savedTarget);
    clearJobsForTests();
  }
});

test('plugin job targets require the plugin to remain enabled', () => {
  assert.equal(jobTargetEnabled('godot_validate', { plugins: { enabled: [] } }), false);
  assert.equal(jobTargetEnabled('godot_validate', { plugins: { enabled: ['devmate.godot'] } }), true);
  assert.equal(jobTargetEnabled('browser_qa_run', { plugins: { enabled: ['devmate.browser-qa'] } }), true);
  assert.equal(jobTargetEnabled('run_smart_checks', { plugins: { enabled: [] } }), true);
});

test.after(async () => {
  await shutdownJobRuntime();
  await fsp.rm(root, { recursive: true, force: true });
});
