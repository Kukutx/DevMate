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
  appVersion: '3.3.0',
  instanceId: 'runner-control-tests',
  auth: { required: true, token: 'owner-token-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'team', publicUrl: 'https://devmate.example.com' },
  team: {
    enabled: true,
    members: [],
    requireWorkspaceLeaseForWrites: false,
    approvals: { enabled: false }
  },
  production: { allowedHosts: [] },
  runnerControl: { enabled: true, credentials: [] },
  runtime: { maxConcurrentJobs: 1 },
  jobs: {},
  activeWorkspaceId: 'app',
  workspaces: [{
    id: 'app',
    name: 'app',
    root: temp,
    mode: 'workspace-write',
    reference: false
  }],
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

const durable = await import('../gateway/durable-state.mjs');
const {
  clearJobsForTests,
  createJob,
  getJob,
  listRunners
} = await import('../gateway/job-queue.mjs');
const { registerJobTarget } = await import('../gateway/job-runtime.mjs');
const {
  __test,
  runnerControlListener,
  resetRunnerControlState
} = await import('../gateway/runner-control-plane.mjs');

function proof(job) {
  return {
    claimGeneration: job.claim.generation,
    claimToken: job.claim.token
  };
}

durable.resetDurableStateForTests();
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

const runner = {
  capabilities: ['core', 'external'],
  workspaceIds: ['app'],
  maxConcurrent: 2,
  version: '3.3.0',
  platform: 'linux',
  arch: 'x64',
  labels: { hostname: 'runner-one' }
};

test('fails closed for public Runner Hosts when production allowlist is empty', () => {
  const production = { deployment: { mode: 'production' }, production: { allowedHosts: [] } };
  assert.equal(__test.hostAllowed({ headers: { host: 'runner.example.com' } }, production), false);
  assert.equal(__test.hostAllowed({ headers: { host: '127.0.0.1:8787' } }, production), true);
  const restricted = {
    deployment: { mode: 'production' },
    production: { allowedHosts: ['runner.example.com'] }
  };
  assert.equal(__test.hostAllowed({ headers: { host: 'runner.example.com' } }, restricted), true);
  assert.equal(__test.hostAllowed({ headers: { host: 'evil.example.com' } }, restricted), false);
  const team = { deployment: { mode: 'team' }, production: { allowedHosts: [] } };
  assert.equal(__test.hostAllowed({ headers: { host: 'runner.example.com' } }, team), true);
});

test('rejects invalid credentials, protocol versions, and malformed request bodies', async () => {
  const wrongProtocol = await request('/heartbeat', created.token, {}, '2');
  assert.equal(wrongProtocol.response.status, 426);
  const invalid = await request('/heartbeat', 'dmr_missing_invalid-token-value-long-enough', {});
  assert.equal(invalid.response.status, 401);
  const arrayBody = await request('/heartbeat', created.token, []);
  assert.equal(arrayBody.response.status, 400);
  assert.match(arrayBody.json.error, /JSON object/);
});

test('rejects Runner metadata outside credential scope instead of silently intersecting or clamping', async () => {
  const cases = [
    [{ ...runner, workspaceIds: ['app', 'other'] }, /workspaceIds contains values outside credential scope/],
    [{ ...runner, capabilities: ['core', 'external', 'unapproved'] }, /capabilities contains values outside credential scope/],
    [{ ...runner, capabilities: ['external'] }, /must explicitly include core and external/],
    [{ ...runner, maxConcurrent: 3 }, /maxConcurrent/],
    [{ ...runner, maxConcurrent: '2' }, /maxConcurrent/],
    [{ ...runner, labels: [] }, /labels must be an object/],
    [{ ...runner, version: 42 }, /version must be a string/]
  ];
  for (const [metadata, pattern] of cases) {
    const result = await request('/heartbeat', created.token, { runner: metadata });
    assert.equal(result.response.status, 400);
    assert.match(result.json.error, pattern);
  }
});

test('registers, claims, renews, and completes a strictly scoped remote job', async () => {
  const heartbeat = await request('/heartbeat', created.token, { runner });
  assert.equal(heartbeat.response.status, 200);
  assert.deepEqual(heartbeat.json.runner.capabilities, ['core', 'external']);
  assert.deepEqual(heartbeat.json.runner.workspaceIds, ['app']);
  assert.equal(heartbeat.json.runner.maxConcurrent, 2);
  assert.equal(heartbeat.json.runner.version, '3.3.0');

  const claimed = await request('/jobs/claim', created.token, { runner, leaseSeconds: 60 });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.json.job.id, queued.id);
  assert.deepEqual(claimed.json.job.arguments, { workspaceId: 'app' });
  assert.deepEqual(claimed.json.job.artifactPaths, ['artifacts/report.json']);
  assert.equal(claimed.json.job.claim.generation, 1);
  assert.match(claimed.json.job.claim.token, /^[A-Za-z0-9_-]{43}$/);

  const missingProof = await request(`/jobs/${queued.id}/renew`, created.token, { leaseSeconds: 60 });
  assert.equal(missingProof.response.status, 400);
  assert.equal(missingProof.json.code, 'claim_fence_proof_required');

  const renewed = await request(
    `/jobs/${queued.id}/renew`,
    created.token,
    { leaseSeconds: 60, ...proof(claimed.json.job) }
  );
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.json.renewed, true);
  assert.equal(renewed.json.cancelRequested, false);
  const runnerAfterRenew = listRunners().find(item => item.id === created.credential.id);
  assert.equal(runnerAfterRenew.version, '3.3.0');
  assert.equal(runnerAfterRenew.platform, 'linux');
  assert.equal(runnerAfterRenew.labels.hostname, 'runner-one');

  const completed = await request(
    `/jobs/${queued.id}/complete`,
    created.token,
    {
      ...proof(claimed.json.job),
      result: {
        ok: true,
        token: 'must-not-persist',
        text: 'Bearer abcdefghijklmnopqrstuvwxyz'
      },
      artifacts: [
        {
          workspaceId: 'other',
          path: 'artifacts/report.json',
          bytes: 12,
          sha256: 'a'.repeat(64),
          modifiedAt: new Date().toISOString()
        },
        { path: '.env', bytes: 1 },
        { path: 'secrets/key.pem', bytes: 1 },
        { path: 'C:/absolute/file.txt', bytes: 1 },
        { path: 'artifacts/report.json', bytes: 12 }
      ]
    }
  );
  assert.equal(completed.response.status, 200);
  const job = getJob(queued.id, { includeResult: true });
  assert.equal(job.status, 'succeeded');
  assert.equal(job.result.token, 'redacted');
  assert.match(job.result.text, /redacted/);
  assert.equal(job.artifacts.length, 1);
  assert.equal(job.artifacts[0].workspaceId, 'app');
  assert.equal(job.artifacts[0].runnerId, created.credential.id);
  assert.equal(job.artifacts[0].remote, true);
});

test('rejects stale completion after a lease expires and the same Runner reclaims the job', async () => {
  const job = createJob({
    principal,
    tool: 'project_snapshot',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core', 'external'],
    maxAttempts: 2
  });
  await request('/heartbeat', created.token, { runner });
  const first = await request('/jobs/claim', created.token, { runner, leaseSeconds: 60 });
  assert.equal(first.json.job.id, job.id);
  const store = durable.readDurableNamespace('jobs', null);
  const internal = store.jobs.find(item => item.id === job.id);
  internal.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
  durable.writeDurableNamespace('jobs', store);

  const second = await request('/jobs/claim', created.token, { runner, leaseSeconds: 60 });
  assert.equal(second.json.job.id, job.id);
  assert.equal(second.json.job.claim.generation, 2);

  const stale = await request(`/jobs/${job.id}/complete`, created.token, {
    ...proof(first.json.job),
    result: { ok: true, stale: true }
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.json.code, 'claim_fence_invalid');
  assert.equal(getJob(job.id).status, 'running');

  const current = await request(`/jobs/${job.id}/complete`, created.token, {
    ...proof(second.json.job),
    result: { ok: true, stale: false }
  });
  assert.equal(current.response.status, 200);
  assert.equal(getJob(job.id, { includeResult: true }).result.stale, false);
});

test('rejects non-boolean retryable flags instead of treating them as true', async () => {
  const job = createJob({
    principal,
    tool: 'project_snapshot',
    args: { workspaceId: 'app' },
    workspaceId: 'app',
    requiredCapabilities: ['core', 'external'],
    maxAttempts: 1
  });
  const claimed = await request('/jobs/claim', created.token, { runner, leaseSeconds: 60 });
  assert.equal(claimed.json.job.id, job.id);
  const invalid = await request(`/jobs/${job.id}/fail`, created.token, {
    ...proof(claimed.json.job),
    error: 'failed',
    retryable: 'false'
  });
  assert.equal(invalid.response.status, 400);
  assert.match(invalid.json.error, /retryable must be a boolean/);
  assert.equal(getJob(job.id).status, 'running');

  const failed = await request(`/jobs/${job.id}/fail`, created.token, {
    ...proof(claimed.json.job),
    error: 'failed',
    retryable: false
  });
  assert.equal(failed.response.status, 200);
  assert.equal(getJob(job.id).status, 'failed');
});

test('sanitizes empty results safely and rejects malformed artifact metadata', () => {
  assert.equal(__test.sanitizeResult(undefined), null);
  assert.equal(__test.artifactPathAllowed('artifacts/report.json'), true);
  assert.equal(__test.artifactPathAllowed('secrets/private.key'), false);
  assert.throws(() => __test.sanitizeArtifacts([{ path: 'report.json', bytes: '12' }], 'runner', 'app'), /artifact.bytes/);
  assert.throws(() => __test.sanitizeArtifacts('not-an-array', 'runner', 'app'), /artifacts must be an array/);
});

test.after(async () => {
  resetRunnerControlState();
  await new Promise(resolve => server.close(resolve));
  await fsp.rm(temp, { recursive: true, force: true });
});
