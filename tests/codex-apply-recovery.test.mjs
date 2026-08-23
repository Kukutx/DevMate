import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-codex-apply-recovery-'));
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
const config = configStore.newInstanceConfig({ workspaceRoot: workspace, appVersion: configStore.DEFAULT_VERSION });
config.auth = { mode: 'none' };
config.permissions.profile = 'fullAccess';
config.agent = { codexCollaborationEnabled: true };
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const durable = await import('../gateway/durable-state.mjs');
const snapshot = await import('../gateway/agent-snapshot.mjs');
const collaboration = await import('../gateway/agent-collaboration.mjs');
const workspaceId = config.activeWorkspaceId;
const workspaceRecord = config.workspaces.find(item => item.id === workspaceId);

function durableTask(taskId) {
  return durable.readDurableNamespace('codex-collaboration', { tasks: [] }).tasks.find(item => item.id === taskId) || null;
}

function markProposalReady(taskId) {
  durable.mutateDurableDocument(document => {
    const state = document.namespaces?.['codex-collaboration'];
    const task = state?.tasks?.find(item => item.id === taskId);
    if (!task) throw new Error(`Missing Codex task ${taskId}`);
    task.status = 'proposal_ready';
    task.snapshotAvailable = true;
    task.error = null;
    state.activeTaskId = null;
    return document;
  });
}

async function prepareModifyTask({ file = 'app.js', before = 'export const value = 1;\n', after = 'export const value = 2;\n' } = {}) {
  await fsp.writeFile(path.join(workspace, file), before, 'utf8');
  const task = collaboration.__test.reserveNewTask({ workspaceId, title: `modify ${file}` });
  const created = await snapshot.createAgentSnapshot({ taskId: task.id, workspace: workspaceRecord });
  await fsp.writeFile(path.join(created.cwd, file), after, 'utf8');
  markProposalReady(task.id);
  const proposal = await snapshot.agentProposalChanges(task.id);
  assert.equal(proposal.blocked.length, 0);
  assert.equal(proposal.changes.length, 1);
  return { task, change: proposal.changes[0], before, after };
}

async function clearFixture() {
  durable.resetDurableStateForTests();
  await fsp.rm(snapshot.AGENT_TASK_ROOT, { recursive: true, force: true }).catch(() => {});
  const entries = await fsp.readdir(workspace).catch(() => []);
  await Promise.all(entries.map(name => fsp.rm(path.join(workspace, name), { recursive: true, force: true })));
}

test.beforeEach(clearFixture);

test('startup recovery rolls back a mutation committed after durable in-flight intent but before appliedCount persistence', async () => {
  const { task, change, before, after } = await prepareModifyTask();
  collaboration.__test.reserveApply(task.id, workspaceId, [change]);
  collaboration.__test.updateApplyProgress(task.id, apply => { apply.inFlightIndex = 0; });

  await fsp.writeFile(path.join(workspace, change.path), after, 'utf8');
  const recovery = await collaboration.recoverCodexApplyAfterFileTransactions();
  assert.deepEqual(recovery.blocked, []);
  assert.deepEqual(recovery.recovered, [{ taskId: task.id }]);
  assert.equal(await fsp.readFile(path.join(workspace, change.path), 'utf8'), before);
  const recoveredTask = durableTask(task.id);
  assert.equal(recoveredTask.status, 'proposal_ready');
  assert.equal(recoveredTask.apply, null);
  assert.equal(durable.readDurableNamespace('codex-collaboration', {}).activeTaskId, null);
});

test('startup recovery fails closed and preserves external divergence instead of guessing', async () => {
  const { task, change } = await prepareModifyTask();
  collaboration.__test.reserveApply(task.id, workspaceId, [change]);
  collaboration.__test.updateApplyProgress(task.id, apply => {
    apply.appliedCount = 1;
    apply.inFlightIndex = null;
  });
  const external = 'export const value = 999; // external edit\n';
  await fsp.writeFile(path.join(workspace, change.path), external, 'utf8');

  const recovery = await collaboration.recoverCodexApplyAfterFileTransactions();
  assert.equal(recovery.recovered.length, 0);
  assert.equal(recovery.blocked.length, 1);
  assert.equal(await fsp.readFile(path.join(workspace, change.path), 'utf8'), external);
  const blockedTask = durableTask(task.id);
  assert.equal(blockedTask.status, 'recovery_blocked');
  assert.equal(blockedTask.apply.status, 'recovery_blocked');
  assert.ok(blockedTask.apply.recoveryFailures.length >= 1);
});

test('rollback of an interrupted delete restores exact baseline content and executable mode', async () => {
  const file = 'script.sh';
  const before = '#!/bin/sh\necho safe\n';
  const full = path.join(workspace, file);
  await fsp.writeFile(full, before, 'utf8');
  if (process.platform !== 'win32') await fsp.chmod(full, 0o755);

  const task = collaboration.__test.reserveNewTask({ workspaceId, title: 'delete executable' });
  const created = await snapshot.createAgentSnapshot({ taskId: task.id, workspace: workspaceRecord });
  await fsp.rm(path.join(created.cwd, file));
  markProposalReady(task.id);
  const proposal = await snapshot.agentProposalChanges(task.id);
  const change = proposal.changes[0];
  assert.equal(change.kind, 'delete');
  collaboration.__test.reserveApply(task.id, workspaceId, [change]);
  collaboration.__test.updateApplyProgress(task.id, apply => { apply.inFlightIndex = 0; });

  await fsp.rm(full);
  const recovery = await collaboration.recoverCodexApplyAfterFileTransactions();
  assert.equal(recovery.blocked.length, 0);
  assert.equal(await fsp.readFile(full, 'utf8'), before);
  if (process.platform !== 'win32') assert.equal((await fsp.stat(full)).mode & 0o777, 0o755);
});

test('recovery never deletes a newly-created path if another actor changed it after the supervised create', async () => {
  const task = collaboration.__test.reserveNewTask({ workspaceId, title: 'create conflict' });
  const created = await snapshot.createAgentSnapshot({ taskId: task.id, workspace: workspaceRecord });
  const rel = 'new-file.ts';
  await fsp.writeFile(path.join(created.cwd, rel), 'export const created = true;\n', 'utf8');
  markProposalReady(task.id);
  const proposal = await snapshot.agentProposalChanges(task.id);
  const change = proposal.changes[0];
  assert.equal(change.kind, 'create');
  collaboration.__test.reserveApply(task.id, workspaceId, [change]);
  collaboration.__test.updateApplyProgress(task.id, apply => { apply.appliedCount = 1; });

  const external = 'export const external = true;\n';
  await fsp.writeFile(path.join(workspace, rel), external, 'utf8');
  const recovery = await collaboration.recoverCodexApplyAfterFileTransactions();
  assert.equal(recovery.blocked.length, 1);
  assert.equal(await fsp.readFile(path.join(workspace, rel), 'utf8'), external);
  assert.equal(durableTask(task.id).status, 'recovery_blocked');
});

test.after(async () => {
  await clearFixture().catch(() => {});
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(temp, { recursive: true, force: true });
});
