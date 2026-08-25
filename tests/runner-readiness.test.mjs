import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';
import publicVerification from '../shared/public-ingress-verification.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runner-readiness-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;

const config = configStore.newInstanceConfig({
  workspaceRoot: temp,
  appVersion: configStore.DEFAULT_VERSION
});
config.instanceId = 'runner-readiness-tests';
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'Application', role: 'active' };
config.auth = { mode: 'oauth' };
config.connection.provider = 'external';
config.connection.publicUrl = 'https://devmate.example.com';
config.requestPolicy.allowedHosts = ['devmate.example.com'];
config.team.requireWorkspaceLeaseForWrites = true;
config.team.approvals = {
  ...config.team.approvals,
  enabled: true,
  requiredCapabilities: ['publish', 'admin'],
  separationOfDuties: true
};
config.jobs.embeddedRunnerEnabled = false;
config.jobs.allowJobGitSave = true;
config.runnerControl.enabled = true;
config.maintenance.auditRetentionDays = 90;

const teamAccess = await import('../gateway/team-access.mjs');
teamAccess.createTeamMember(config, {
  id: 'developer',
  name: 'Developer',
  role: 'developer',
  workspaceIds: ['app']
});

const { createRunnerCredential } = await import('../gateway/runner-access.mjs');
createRunnerCredential(config, {
  name: 'External Runner',
  workspaceIds: ['app'],
  capabilities: ['core', 'external']
});

const verificationStamp = new Date().toISOString();
Object.assign(config.connection, publicVerification.successfulVerificationPatch({
  publicOrigin: config.connection.publicUrl,
  mcpUrl: `${config.connection.publicUrl}/mcp`,
  toolCount: 10,
  toolCallVerified: true,
  probeTool: 'gateway_status',
  server: { name: 'devmate', version: configStore.DEFAULT_VERSION }
}, config.connection.publicUrl, verificationStamp, null, null, 'oauth', 0, 0));
configStore.atomicWriteJson(configPath, config);

const { acquireGatewayInstanceLock, releaseGatewayInstanceLock, resetDurableStateForTests } = await import('../gateway/durable-state.mjs');
const { clearJobsForTests, registerRunner } = await import('../gateway/job-queue.mjs');
const { readiness } = await import('../gateway/team-tool-data.mjs');

resetDurableStateForTests();
clearJobsForTests();
acquireGatewayInstanceLock();

test('background execution is optional when neither embedded nor external Runner is configured', () => {
  const withoutRunners = structuredClone(config);
  withoutRunners.jobs.embeddedRunnerEnabled = false;
  withoutRunners.runnerControl.enabled = false;
  withoutRunners.runnerControl.credentials = [];
  const status = readiness(withoutRunners);
  const execution = status.checks.find(item => item.key === 'runner-execution');
  assert.equal(execution.required, false);
  assert.equal(execution.ok, true);
  assert.equal(status.ready, true);
});

test('external-only execution requires an online external Runner after the public connection is verified', () => {
  const before = readiness(config);
  assert.equal(before.ready, false);
  assert.equal(before.checks.find(item => item.key === 'public-connection')?.ok, true);
  assert.equal(before.checks.find(item => item.key === 'external-runners-online')?.ok, false);
  assert.equal(before.checks.find(item => item.key === 'runner-credentials')?.ok, true);

  registerRunner({
    id: 'external-runner',
    name: 'External Runner',
    capabilities: ['core', 'external'],
    workspaceIds: ['app'],
    maxConcurrent: 1,
    version: configStore.DEFAULT_VERSION,
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
