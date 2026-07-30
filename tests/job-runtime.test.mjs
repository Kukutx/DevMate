import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-job-runtime-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(path.join(workspace, 'artifacts'), { recursive: true });
await fsp.writeFile(configPath, JSON.stringify({
  appVersion: '2.2.0',
  instanceId: 'runtime-tests',
  auth: { required: true, token: 'owner-token-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'personal' },
  team: { enabled: false, members: [], requireWorkspaceLeaseForWrites: false },
  production: {},
  runtime: { maxConcurrentJobs: 1 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'app', root: workspace, mode: 'workspace-write', reference: false }],
  plugins: { enabled: [], settings: {} }
}, null, 2));
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const { installTeamCapabilities } = await import('../gateway/team-capabilities.mjs');
const { getJob, clearJobsForTests } = await import('../gateway/job-queue.mjs');
const { jobTargetEnabled, runJobWorkerOnce, shutdownJobRuntime } = await import('../gateway/job-runtime.mjs');
const { resetDurableStateForTests } = await import('../gateway/durable-state.mjs');

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
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
  await shutdownJobRuntime();
});

test('plugin job targets require the plugin to remain enabled', () => {
  assert.equal(jobTargetEnabled('godot_validate', { plugins: { enabled: [] } }), false);
  assert.equal(jobTargetEnabled('godot_validate', { plugins: { enabled: ['devmate.godot'] } }), true);
  assert.equal(jobTargetEnabled('browser_qa_run', { plugins: { enabled: ['devmate.browser-qa'] } }), true);
  assert.equal(jobTargetEnabled('run_smart_checks', { plugins: { enabled: [] } }), true);
});

test.after(async () => fsp.rm(root, { recursive: true, force: true }));
