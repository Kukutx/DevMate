import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';
import instanceConfig from '../shared/instance-config.cjs';
import {
  ownerOnlyTool,
  requiredCapabilityForTool,
  toolWorkspaceId
} from '../gateway/tool-policy.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-codex-policy-'));
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
const baseConfig = configStore.newInstanceConfig({ workspaceRoot: workspace, appVersion: configStore.DEFAULT_VERSION });
baseConfig.auth = { mode: 'none' };
configStore.atomicWriteJson(configPath, baseConfig);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const durable = await import('../gateway/durable-state.mjs');
const collaboration = await import('../gateway/agent-collaboration.mjs');

test.beforeEach(async () => {
  durable.resetDurableStateForTests();
  await collaboration.configureCodexCollaboration(false);
  collaboration.recoverCodexCollaborationAfterRestart();
});

test('Codex Collaboration is OFF by default and rejects malformed shared preference state', () => {
  const normalized = instanceConfig.normalizeInstanceConfig(configStore.newInstanceConfig({
    workspaceRoot: workspace,
    appVersion: configStore.DEFAULT_VERSION
  }));
  assert.deepEqual(normalized.agent, { codexCollaborationEnabled: false });
  normalized.agent.codexCollaborationEnabled = 'yes';
  assert.throws(
    () => instanceConfig.normalizeInstanceConfig(normalized),
    /agent\.codexCollaborationEnabled must be a boolean/
  );
});

test('Codex tools use existing owner, workspace, execute, and write capability boundaries', () => {
  const config = instanceConfig.normalizeInstanceConfig(configStore.newInstanceConfig({
    workspaceRoot: workspace,
    appVersion: configStore.DEFAULT_VERSION
  }));
  const workspaceId = config.activeWorkspaceId;
  assert.equal(ownerOnlyTool('codex_collaboration_status'), true);
  assert.equal(ownerOnlyTool('codex_collaboration_configure'), true);
  assert.equal(requiredCapabilityForTool('codex_task_start', { destructiveHint: true }, {}), 'execute');
  assert.equal(requiredCapabilityForTool('codex_task_continue', { destructiveHint: true }, {}), 'execute');
  assert.equal(requiredCapabilityForTool('codex_proposal_apply', { destructiveHint: true }, {}), 'write');
  assert.equal(requiredCapabilityForTool('codex_proposal_status', { readOnlyHint: true }, {}), 'read');
  assert.equal(toolWorkspaceId('codex_task_start', { workspaceId }, config), workspaceId);
  assert.equal(toolWorkspaceId('codex_proposal_apply', { workspaceId }, config), workspaceId);
  assert.equal(toolWorkspaceId('codex_collaboration_status', {}, config), null);
});

test('shared ON/OFF preference is durable and does not require starting Codex', async () => {
  assert.equal(collaboration.codexCollaborationStatus().enabled, false);
  assert.deepEqual(await collaboration.configureCodexCollaboration(true), { enabled: true });
  assert.equal(collaboration.codexCollaborationStatus().enabled, true);
  assert.equal(collaboration.codexCollaborationStatus().runtime.running, false);
  assert.deepEqual(await collaboration.configureCodexCollaboration(false), { enabled: false });
  assert.equal(collaboration.codexCollaborationStatus().enabled, false);
});

test('only one active Codex task is reserved and stale runtime state is interrupted on restart', () => {
  const first = collaboration.__test.reserveNewTask({ workspaceId: baseConfig.activeWorkspaceId, title: 'First' });
  assert.equal(first.status, 'preparing');
  assert.throws(
    () => collaboration.__test.reserveNewTask({ workspaceId: baseConfig.activeWorkspaceId, title: 'Second' }),
    error => error?.code === 'codex_task_active'
  );
  collaboration.recoverCodexCollaborationAfterRestart();
  const status = collaboration.codexCollaborationStatus();
  assert.equal(status.activeTaskId, null);
  assert.equal(status.tasks[0].id, first.id);
  assert.equal(status.tasks[0].status, 'interrupted');
  assert.match(status.tasks[0].error, /Previous Gateway exited/);
});

test('production runtime loads collaboration after singleton ownership and recovers apply only after file journals', async () => {
  const runtime = await fsp.readFile(new URL('../gateway/server-runtime.mjs', import.meta.url), 'utf8');
  const collaborationSource = await fsp.readFile(new URL('../gateway/agent-collaboration.mjs', import.meta.url), 'utf8');
  const acquire = runtime.indexOf('acquireGatewayInstanceLock()');
  const dynamicImport = runtime.indexOf('await import(');
  const collaborationPath = runtime.search(/agent-collaboration\.mjs/);
  const load = dynamicImport >= 0 && collaborationPath > dynamicImport ? dynamicImport : -1;
  const fileRecovery = runtime.indexOf('recoverFileTransactions');
  const applyRecovery = runtime.indexOf('recoverCodexApplyAfterFileTransactions');
  const install = runtime.indexOf('installCodexCollaborationCapability(McpServer)');
  assert.ok(acquire >= 0 && load > acquire && fileRecovery > load && applyRecovery > fileRecovery && install > applyRecovery);
  assert.equal(/\bAPPLY\b/.test(collaborationSource), false);
  assert.match(collaborationSource, /expectedSha256: change\.beforeSha256/);
  assert.match(collaborationSource, /recoverCodexApplyAfterFileTransactions/);
  assert.match(collaborationSource, /recovery_blocked/);
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(temp, { recursive: true, force: true });
});
