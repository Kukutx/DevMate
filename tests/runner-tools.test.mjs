import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-runner-tools-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;

const config = configStore.newInstanceConfig({
  workspaceRoot: temp,
  appVersion: configStore.DEFAULT_VERSION
});
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'Application', role: 'active' };
config.permissions.profile = 'fullAccess';
config.team.requireWorkspaceLeaseForWrites = false;
config.jobs.embeddedRunnerEnabled = true;
config.runnerControl.enabled = false;

const teamAccess = await import('../gateway/team-access.mjs');
const reviewerMember = teamAccess.createTeamMember(config, {
  id: 'reviewer',
  name: 'Reviewer',
  role: 'reviewer',
  workspaceIds: ['app']
}).member;
const maintainerMember = teamAccess.createTeamMember(config, {
  id: 'maintainer',
  name: 'Maintainer',
  role: 'maintainer',
  workspaceIds: ['app']
}).member;
configStore.atomicWriteJson(configPath, config);

const { __test, registerRunnerTools } = await import('../gateway/runner-tools.mjs');
const { runWithRequestContext } = await import('../gateway/request-context.mjs');

function principal(role) {
  if (role === 'owner') {
    return { id: 'local-owner', name: 'Local owner', role: 'owner', source: 'local', workspaceIds: [] };
  }
  const member = role === 'maintainer' ? maintainerMember : reviewerMember;
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    source: 'oauth-member',
    workspaceIds: [...member.workspaceIds],
    authVersion: member.authVersion
  };
}

const tools = new Map();
registerRunnerTools(
  (name, toolConfig, handler) => tools.set(name, { config: toolConfig, handler }),
  {
    ro: { readOnlyHint: true, destructiveHint: false },
    rw: { readOnlyHint: false, destructiveHint: true }
  }
);

test('Runner runtime reporting treats missing embedded-runner state as disabled', () => {
  const runtimeConfig = { jobs: {}, runnerControl: { enabled: false, path: '/runner/v1', maxRequestBytes: 65536, requestsPerMinute: 30, maxCredentials: 1, credentials: [] } };
  assert.equal(__test.publicRuntime(runtimeConfig).embeddedRunnerEnabled, false);
});

test('Runner runtime reporting counts only usable credentials as active', () => {
  const runtimeConfig = {
    jobs: {},
    runnerControl: {
      enabled: true,
      path: '/runner/v1',
      maxRequestBytes: 65536,
      requestsPerMinute: 30,
      maxCredentials: 4,
      credentials: [
        { disabled: false, salt: 'salt', tokenHash: 'hash', workspaceIds: ['app'] },
        { disabled: false, workspaceIds: ['app'] },
        { disabled: false, salt: 'salt', tokenHash: 'hash', workspaceIds: [] },
        { disabled: true, salt: 'salt', tokenHash: 'hash', workspaceIds: ['app'] }
      ]
    }
  };
  assert.equal(__test.publicRuntime(runtimeConfig).activeCredentials, 1);
});

test('Runner topology status distinguishes configured and live embedded state', async () => {
  await assert.rejects(
    runWithRequestContext({ principal: principal('reviewer') }, () =>
      tools.get('runner_control_status').handler({})
    ),
    /maintainer or owner/
  );
  const status = await runWithRequestContext({ principal: principal('maintainer') }, () =>
    tools.get('runner_control_status').handler({})
  );
  assert.equal(status.structuredContent.embeddedRunnerEnabled, true);
  assert.equal(status.structuredContent.embeddedRunnerRunning, false);
  assert.equal(status.structuredContent.externalControlEnabled, false);
});

test('Runner control reports restart only when desired lifecycle differs from live state', async () => {
  await assert.rejects(
    runWithRequestContext({ principal: principal('maintainer') }, () =>
      tools.get('runner_control_configure').handler({ enabled: true })
    ),
    /owner role/
  );

  const disabled = await runWithRequestContext({ principal: principal('owner') }, () =>
    tools.get('runner_control_configure').handler({ enabled: true, embeddedRunnerEnabled: false })
  );
  assert.equal(disabled.structuredContent.runnerControl.externalControlEnabled, true);
  assert.equal(disabled.structuredContent.runnerControl.embeddedRunnerEnabled, false);
  assert.equal(disabled.structuredContent.runnerControl.embeddedRunnerRunning, false);
  assert.equal(disabled.structuredContent.restartRequired, false);

  const enabled = await runWithRequestContext({ principal: principal('owner') }, () =>
    tools.get('runner_control_configure').handler({ embeddedRunnerEnabled: true })
  );
  assert.equal(enabled.structuredContent.runnerControl.embeddedRunnerEnabled, true);
  assert.equal(enabled.structuredContent.runnerControl.embeddedRunnerRunning, false);
  assert.equal(enabled.structuredContent.restartRequired, true);
});

test('Runner credentials require owner and preserve explicit workspace scope', async () => {
  await assert.rejects(
    runWithRequestContext({ principal: principal('maintainer') }, () =>
      tools.get('runner_credential_create').handler({
        name: 'Runner',
        workspaceIds: ['app']
      })
    ),
    /owner role/
  );
  const created = await runWithRequestContext({ principal: principal('owner') }, () =>
    tools.get('runner_credential_create').handler({
      name: 'Runner',
      workspaceIds: ['Application'],
      capabilities: ['linux-x64'],
      maxConcurrent: 2
    })
  );
  assert.match(created.structuredContent.token, /^dmr_/);
  assert.deepEqual(created.structuredContent.credential.workspaceIds, ['app']);
  assert.equal(created.structuredContent.credential.capabilities.includes('external'), true);
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
