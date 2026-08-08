import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runner-readiness-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;

const config = {
  version: 11,
  appVersion: '3.3.0',
  instanceId: 'runner-readiness-tests',
  auth: { required: true, token: 'owner-token-long-enough' },
  connection: { provider: 'external', publicUrl: 'https://devmate.example.com' },
  team: {
    members: [{ id: 'developer', name: 'Developer', role: 'developer', disabled: false, workspaceIds: ['app'] }],
    requireWorkspaceLeaseForWrites: true,
    approvals: { enabled: true, requiredCapabilities: ['publish', 'admin'], separationOfDuties: true }
  },
  requestPolicy: {
    allowedHosts: ['devmate.example.com'],
    maxRequestBytes: 2097152,
    requestsPerMinute: 120,
    maxConcurrentRequests: 24,
    maxConcurrentPerPrincipal: 4,
    requestTimeoutMs: 900000
  },
  runtime: { maxConcurrentJobs: 2 },
  jobs: { embeddedRunnerEnabled: false, allowJobGitSave: true },
  runnerControl: { enabled: true, credentials: [] },
  maintenance: { auditRetentionDays: 90 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'Application', root: temp, mode: 'workspace-write', reference: false }]
};

const { createRunnerCredential } = await import('../gateway/runner-access.mjs');
createRunnerCredential(config, {
  name: 'External Runner',
  workspaceIds: ['app'],
  capabilities: ['core', 'external']
});
await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

const { acquireGatewayInstanceLock, releaseGatewayInstanceLock, resetDurableStateForTests } = await import('../gateway/durable-state.mjs');
const { clearJobsForTests, registerRunner } = await import('../gateway/job-queue.mjs');
const { readiness } = await import('../gateway/team-tool-data.mjs');

resetDurableStateForTests();
clearJobsForTests();
acquireGatewayInstanceLock();

test('external-only execution requires an online external Runner', () => {
  const before = readiness(config);
  assert.equal(before.ready, false);
  assert.equal(before.checks.find(item => item.key === 'external-runners-online')?.ok, false);
  assert.equal(before.checks.find(item => item.key === 'runner-credentials')?.ok, true);

  registerRunner({
    id: 'external-runner',
    name: 'External Runner',
    capabilities: ['core', 'external'],
    workspaceIds: ['app'],
    maxConcurrent: 1,
    version: '3.3.0',
    platform: 'linux',
    arch: 'x64',
    labels: { kind: 'external' }
  });

  const after = readiness(config);
  assert.equal(after.ready, true);
  assert.equal(after.checks.find(item => item.key === 'external-runners-online')?.ok, true);
  assert.equal(after.checks.find(item => item.key === 'runner-credentials')?.ok, true);
});

test.after(async () => {
  releaseGatewayInstanceLock();
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
