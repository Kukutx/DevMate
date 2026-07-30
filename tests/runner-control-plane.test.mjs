import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runner-control-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const baseConfig = {
  appVersion: '2.3.0',
  instanceId: 'runner-control-tests',
  auth: { required: true, token: 'owner-token-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'team', publicUrl: 'https://devmate.example.com' },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: false, approvals: { enabled: false } },
  production: { allowedHosts: [] },
  runnerControl: { enabled: true, credentials: [] },
  runtime: { maxConcurrentJobs: 1 },
  jobs: {},
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'app', root: temp, mode: 'workspace-write', reference: false }],
  plugins: { enabled: [], settings: {} },
  maintenance: { auditRetentionDays: 30 }
};

const runnerAccess = await import('../gateway/runner-access.mjs');
const created = runnerAccess.createRunnerCredential(baseConfig, {
  name: 'Remote Linux',
  workspaceIds: ['app'],
  capabilities: ['core', 'external'],
  maxConcurrent: 2
});
await fsp.writeFile(configPath, JSON.stringify(baseConfig, null, 2), 'utf8');

const { resetDurableStateForTests } = await import('../gateway/durable-state.mjs');
const { clearJobsForTests, createJob, getJob } = await import('../gateway/job-queue.mjs');
const { registerJobTarget } = await import('../gateway/job-runtime.mjs');
const { runnerControlListener, resetRunnerControlState } = await import('../gateway/runner-control-plane.mjs');

resetDurableStateForTests();
clearJobsForTests();
registerJobTarget('project_snapshot', {
  title: 'Project snapshot',
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async () => ({ structuredContent: { ok: true } }));

const principal = {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  source: 'team-token',
  workspaceIds: ['app']
};
const queued = createJob({
  principal,
  tool: 'project_snapshot',
  args: { workspaceId: 'app' },
  workspaceId: 'app',
  requiredCapabilities: ['core', 'external'],
  artifactPaths: ['artifacts/report.json']
});

const server = http.createServer(runnerControlListener((req, res) => {
  res.writeHead(404);
  res.end();
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function request(relative, token = created.token, body = {}, protocol = '1') {
  const response = await fetch(`${origin}/runner/v1${relative}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-devmate-runner-protocol': protocol
    },
    body: JSON.stringify(body)
  });
  return { response, json: await response.json() };
}

test('rejects invalid credentials and protocol versions', async () => {
  const wrongProtocol = await request('/heartbeat', created.token, {}, '2');
  assert.equal(wrongProtocol.response.status, 426);
  const invalid = await request('/heartbeat', 'dmr_missing_invalid-token-value-long-enough', {});
  assert.equal(invalid.response.status, 401);
});

test('registers, claims, renews, and completes a scoped remote job', async () => {
  const runner = {
    capabilities: ['core', 'external', 'unapproved-capability'],
    workspaceIds: ['app', 'other'],
    maxConcurrent: 8,
    version: '2.3.0',
    platform: 'linux',
    arch: 'x64'
  };
  const heartbeat = await request('/heartbeat', created.token, { runner });
  assert.equal(heartbeat.response.status, 200);
  assert.deepEqual(heartbeat.json.runner.capabilities, ['core', 'external']);
  assert.deepEqual(heartbeat.json.runner.workspaceIds, ['app']);
  assert.equal(heartbeat.json.runner.maxConcurrent, 2);

  const claimed = await request('/jobs/claim', created.token, { runner, leaseSeconds: 60 });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.json.job.id, queued.id);
  assert.deepEqual(claimed.json.job.arguments, { workspaceId: 'app' });
  assert.deepEqual(claimed.json.job.artifactPaths, ['artifacts/report.json']);

  const renewed = await request(`/jobs/${queued.id}/renew`, created.token, { leaseSeconds: 60 });
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.json.renewed, true);
  assert.equal(renewed.json.cancelRequested, false);

  const completed = await request(`/jobs/${queued.id}/complete`, created.token, {
    result: { ok: true, token: 'must-not-persist', text: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    artifacts: [{ workspaceId: 'other', path: 'artifacts/report.json', bytes: 12, sha256: 'a'.repeat(64), modifiedAt: new Date().toISOString() }]
  });
  assert.equal(completed.response.status, 200);
  const job = getJob(queued.id, { includeResult: true });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.token, 'redacted');
  assert.match(job.result.text, /redacted/);
  assert.equal(job.artifacts[0].workspaceId, 'app');
  assert.equal(job.artifacts[0].runnerId, created.credential.id);
  assert.equal(job.artifacts[0].remote, true);
});

test.after(async () => {
  resetRunnerControlState();
  await new Promise(resolve => server.close(resolve));
  await fsp.rm(temp, { recursive: true, force: true });
});
