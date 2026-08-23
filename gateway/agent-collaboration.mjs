import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { mutateDurableDocument, readDurableNamespace } from './durable-state.mjs';
import { mutateConfig, readConfig, toolText } from './local-shared.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';
import { safeFileMutationHandler } from './file-mutation-safety.mjs';
import {
  AGENT_TASK_ROOT,
  agentProposalChanges,
  assertAgentProposalConflictFree,
  createAgentSnapshot,
  readAgentProposalFile,
  readAgentSnapshotManifest,
  removeAgentSnapshot
} from './agent-snapshot.mjs';
import {
  codexRuntime,
  codexRuntimeStatus,
  shutdownCodexRuntime
} from './agent-codex-runtime.mjs';

const NAMESPACE = 'codex-collaboration';
const ACTIVE_STATUSES = new Set(['preparing', 'running']);
const CONTINUABLE_STATUSES = new Set(['proposal_ready', 'completed', 'failed', 'interrupted']);
const MAX_TASKS = 20;
const MAX_TITLE = 200;
const MAX_OUTPUT = 20_000;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function emptyState() {
  return { version: 1, activeTaskId: null, tasks: [] };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function now() { return new Date().toISOString(); }

function codedError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1) return emptyState();
  const tasks = Array.isArray(raw.tasks) ? raw.tasks.filter(item => item?.id && item?.workspaceId).slice(-MAX_TASKS) : [];
  const activeTaskId = tasks.some(item => item.id === raw.activeTaskId && ACTIVE_STATUSES.has(item.status))
    ? raw.activeTaskId
    : null;
  return { version: 1, activeTaskId, tasks };
}

function readState() {
  return normalizeState(readDurableNamespace(NAMESPACE, emptyState()));
}

function writeStateInDocument(document, state) {
  document.namespaces ||= {};
  document.namespaces[NAMESPACE] = normalizeState(state);
}

function mutateState(mutator) {
  let output;
  mutateDurableDocument(document => {
    const state = normalizeState(document.namespaces?.[NAMESPACE]);
    output = mutator(state);
    writeStateInDocument(document, state);
    return document;
  });
  return output;
}

function taskById(state, taskId) {
  return state.tasks.find(item => item.id === String(taskId || '')) || null;
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    workspaceId: task.workspaceId,
    title: task.title,
    status: task.status,
    threadId: task.threadId || null,
    turnId: task.turnId || null,
    turnStatus: task.turnStatus || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt || null,
    appliedAt: task.appliedAt || null,
    error: task.error || null,
    output: task.output || '',
    proposal: task.proposal ? clone(task.proposal) : null,
    snapshotAvailable: task.snapshotAvailable === true
  };
}

function collaborationConfig(config = readConfig()) {
  return { enabled: config?.agent?.codexCollaborationEnabled === true };
}

function requireEnabled() {
  if (!collaborationConfig().enabled) {
    throw codedError('Codex Collaboration is OFF. Enable it before delegating a task.', 'codex_collaboration_disabled');
  }
}

function writableWorkspace(config, workspaceId) {
  const workspace = resolveWorkspace(config, workspaceId);
  if (workspace.reference || (workspace.mode || 'workspace-write') === 'readonly') {
    throw codedError(`Workspace is readonly/reference: ${workspace.id}`, 'codex_workspace_readonly');
  }
  return workspace;
}

function reserveNewTask({ workspaceId, title }) {
  const id = `codex-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  return mutateState(state => {
    if (state.activeTaskId) {
      const active = taskById(state, state.activeTaskId);
      throw codedError(`Codex task ${active?.id || state.activeTaskId} is already active`, 'codex_task_active');
    }
    const timestamp = now();
    const task = {
      id,
      workspaceId,
      title: String(title || 'Codex task').trim().slice(0, MAX_TITLE) || 'Codex task',
      status: 'preparing',
      threadId: null,
      turnId: null,
      turnStatus: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      appliedAt: null,
      error: null,
      output: '',
      proposal: null,
      snapshotAvailable: false
    };
    state.tasks.push(task);
    if (state.tasks.length > MAX_TASKS) state.tasks = state.tasks.slice(-MAX_TASKS);
    state.activeTaskId = id;
    return clone(task);
  });
}

function updateTask(taskId, updater) {
  return mutateState(state => {
    const task = taskById(state, taskId);
    if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
    updater(task, state);
    task.updatedAt = now();
    return clone(task);
  });
}

function releaseActive(state, task) {
  if (state.activeTaskId === task.id) state.activeTaskId = null;
}

function reserveContinuation(taskId, workspaceId) {
  return mutateState(state => {
    if (state.activeTaskId && state.activeTaskId !== taskId) {
      throw codedError(`Codex task ${state.activeTaskId} is already active`, 'codex_task_active');
    }
    const task = taskById(state, taskId);
    if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
    if (task.workspaceId !== workspaceId) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
    if (!task.threadId || !task.snapshotAvailable) throw codedError('Codex task has no resumable snapshot/thread state', 'codex_task_not_resumable');
    if (!CONTINUABLE_STATUSES.has(task.status)) throw codedError(`Codex task cannot continue from status ${task.status}`, 'codex_task_not_resumable');
    task.status = 'preparing';
    task.error = null;
    task.turnId = null;
    task.turnStatus = null;
    task.updatedAt = now();
    state.activeTaskId = task.id;
    return clone(task);
  });
}

function markFailure(taskId, error) {
  try {
    return updateTask(taskId, (task, state) => {
      task.status = ['codex_turn_idle_timeout', 'codex_turn_timeout', 'codex_transport_closed', 'codex_stopped'].includes(error?.code)
        ? 'interrupted'
        : 'failed';
      task.error = String(error?.message || error).slice(0, 4000);
      task.turnStatus = null;
      releaseActive(state, task);
    });
  } catch {
    return null;
  }
}

async function finalizeTurn(taskId, result) {
  const proposal = await agentProposalChanges(taskId);
  const hasChanges = proposal.changes.length > 0 || proposal.blocked.length > 0;
  const failedTurn = ['failed', 'interrupted', 'cancelled'].includes(String(result.status || '').toLowerCase());
  const updated = updateTask(taskId, (task, state) => {
    task.turnId = result.turnId;
    task.turnStatus = result.status;
    task.output = String(result.output || '').slice(-MAX_OUTPUT);
    task.proposal = {
      changeCount: proposal.changes.length,
      blockedCount: proposal.blocked.length,
      changes: proposal.changes.slice(0, 500),
      blocked: proposal.blocked.slice(0, 500)
    };
    task.completedAt = now();
    task.status = hasChanges ? 'proposal_ready' : failedTurn ? 'failed' : 'completed';
    if (failedTurn && result.error) task.error = String(result.error).slice(0, 4000);
    releaseActive(state, task);
  });
  if (!hasChanges && !failedTurn) {
    await removeAgentSnapshot(taskId).catch(() => {});
    updateTask(taskId, task => { task.snapshotAvailable = false; });
  }
  return updated;
}

async function captureActiveTurn(taskId, runtime, threadId, turnPromise) {
  let settled = false;
  void turnPromise.finally(() => { settled = true; }).catch(() => {});
  for (let attempt = 0; attempt < 300 && !settled; attempt += 1) {
    const active = runtime.status().activeTurn;
    if (active?.threadId === threadId && active.turnId) {
      updateTask(taskId, current => {
        current.status = 'running';
        current.turnId = active.turnId;
      });
      return;
    }
    await delay(100);
  }
}

async function executeTurn({ task, workspace, prompt }) {
  const runtime = codexRuntime();
  try {
    if (!task.snapshotAvailable) {
      await createAgentSnapshot({ taskId: task.id, workspace });
      updateTask(task.id, current => { current.snapshotAvailable = true; });
    } else {
      await readAgentSnapshotManifest(task.id);
    }
    const cwd = path.join(AGENT_TASK_ROOT, task.id, 'workspace');
    const thread = await runtime.ensureThread({ threadId: task.threadId || '', cwd });
    updateTask(task.id, current => {
      current.threadId = thread.threadId;
      current.status = 'running';
      current.error = null;
    });

    const turnPromise = runtime.runTurn({ threadId: thread.threadId, cwd, prompt });
    await captureActiveTurn(task.id, runtime, thread.threadId, turnPromise);
    const result = await turnPromise;
    return finalizeTurn(task.id, result);
  } catch (error) {
    markFailure(task.id, error);
    throw error;
  }
}

export async function startCodexTask({ workspaceId, title = '', prompt }) {
  requireEnabled();
  const config = readConfig();
  const workspace = writableWorkspace(config, workspaceId);
  const task = reserveNewTask({ workspaceId: workspace.id, title });
  return executeTurn({ task, workspace, prompt });
}

export async function continueCodexTask({ workspaceId, taskId, prompt }) {
  requireEnabled();
  const config = readConfig();
  const workspace = writableWorkspace(config, workspaceId);
  const task = reserveContinuation(taskId, workspace.id);
  return executeTurn({ task, workspace, prompt });
}

export async function steerCodexTask({ workspaceId, taskId, prompt }) {
  requireEnabled();
  const state = readState();
  const task = taskById(state, taskId);
  if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
  if (task.workspaceId !== workspaceId) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
  if (task.status !== 'running' || !task.threadId || !task.turnId) throw codedError('Codex task has no active steerable turn', 'codex_turn_not_active');
  await codexRuntime().steer(task.threadId, task.turnId, prompt);
  return publicTask(task);
}

export async function interruptCodexTask({ workspaceId, taskId }) {
  const state = readState();
  const task = taskById(state, taskId);
  if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
  if (task.workspaceId !== workspaceId) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
  let runtimeResult = { interrupted: false };
  if (task.threadId && task.turnId) runtimeResult = await codexRuntime().interrupt(task.threadId, task.turnId).catch(() => ({ interrupted: false }));
  const updated = updateTask(task.id, (current, currentState) => {
    current.status = 'interrupted';
    current.error = 'Interrupted by supervisor';
    releaseActive(currentState, current);
  });
  return { task: publicTask(updated), runtime: runtimeResult };
}

export async function codexProposal({ workspaceId, taskId }) {
  const state = readState();
  const task = taskById(state, taskId);
  if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
  if (task.workspaceId !== workspaceId) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
  if (!task.snapshotAvailable) return { task: publicTask(task), changes: [], blocked: [] };
  const proposal = await agentProposalChanges(task.id);
  return { task: publicTask(task), ...proposal };
}

async function rollbackApplied(workspaceId, applied) {
  const failures = [];
  const restore = safeFileMutationHandler('restore_backup');
  const remove = safeFileMutationHandler('delete_file');
  for (const item of [...applied].reverse()) {
    try {
      if (item.kind === 'create') {
        await remove({ workspaceId, path: item.path, recursive: false });
      } else if (item.backup) {
        await restore({ workspaceId, backupPath: item.backup, targetPath: item.path, overwrite: true });
      } else {
        failures.push({ path: item.path, error: 'No rollback backup was returned' });
      }
    } catch (error) {
      failures.push({ path: item.path, error: String(error?.message || error).slice(0, 1000) });
    }
  }
  return failures;
}

export async function applyCodexProposal({ workspaceId, taskId }) {
  requireEnabled();
  const config = readConfig();
  const workspace = writableWorkspace(config, workspaceId);
  const state = readState();
  const task = taskById(state, taskId);
  if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
  if (task.workspaceId !== workspace.id) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
  if (task.status !== 'proposal_ready' || !task.snapshotAvailable) throw codedError(`Codex proposal is not ready from status ${task.status}`, 'codex_proposal_not_ready');

  const proposal = await agentProposalChanges(task.id);
  if (proposal.blocked.length) {
    throw codedError(`Codex proposal contains ${proposal.blocked.length} blocked non-text/oversized change(s)`, 'codex_proposal_blocked', { blocked: proposal.blocked.slice(0, 100) });
  }
  if (!proposal.changes.length) throw codedError('Codex proposal has no changes to apply', 'codex_proposal_empty');

  for (const change of proposal.changes) {
    await assertAgentProposalConflictFree({ workspaceRoot: workspace.root, change });
  }

  const create = safeFileMutationHandler('create_file');
  const write = safeFileMutationHandler('write_file');
  const remove = safeFileMutationHandler('delete_file');
  const applied = [];
  try {
    for (const change of proposal.changes) {
      if (change.kind === 'create') {
        const content = await readAgentProposalFile(task.id, change.path);
        await create({ workspaceId: workspace.id, path: change.path, content, overwrite: false, createDirs: true });
        applied.push({ kind: 'create', path: change.path, backup: null });
      } else if (change.kind === 'modify') {
        const content = await readAgentProposalFile(task.id, change.path);
        const result = await write({ workspaceId: workspace.id, path: change.path, content, append: false, createDirs: false });
        applied.push({ kind: 'modify', path: change.path, backup: result?.structuredContent?.backup || null });
      } else if (change.kind === 'delete') {
        const result = await remove({ workspaceId: workspace.id, path: change.path, recursive: false });
        applied.push({ kind: 'delete', path: change.path, backup: result?.structuredContent?.backup || null });
      }
    }
  } catch (error) {
    const rollbackFailures = await rollbackApplied(workspace.id, applied);
    throw codedError(
      rollbackFailures.length
        ? `Codex proposal apply failed and ${rollbackFailures.length} rollback operation(s) also failed`
        : `Codex proposal apply failed and completed operations were rolled back: ${error?.message || error}`,
      rollbackFailures.length ? 'codex_proposal_rollback_degraded' : 'codex_proposal_apply_failed',
      { cause: error, rollbackFailures }
    );
  }

  const updated = updateTask(task.id, current => {
    current.status = 'applied';
    current.appliedAt = now();
    current.proposal = {
      changeCount: proposal.changes.length,
      blockedCount: 0,
      changes: proposal.changes.slice(0, 500),
      blocked: []
    };
  });
  await removeAgentSnapshot(task.id).catch(() => {});
  updateTask(task.id, current => { current.snapshotAvailable = false; });
  return { task: publicTask(updated), applied: applied.map(item => ({ kind: item.kind, path: item.path })) };
}

export function configureCodexCollaboration(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const config = mutateConfig(current => {
    current.agent ||= {};
    current.agent.codexCollaborationEnabled = enabled;
    return current;
  });
  return { enabled: config.agent?.codexCollaborationEnabled === true };
}

export function codexCollaborationStatus() {
  const state = readState();
  return {
    enabled: collaborationConfig().enabled,
    runtime: codexRuntimeStatus(),
    activeTaskId: state.activeTaskId,
    tasks: state.tasks.slice().reverse().map(publicTask),
    constraints: {
      maxActiveTasks: 1,
      realWorkspaceDirectWriteByCodex: false,
      applyRequiresSnapshotConflictCheck: true,
      strongOsReadIsolation: false
    }
  };
}

function registerCodexTools(server) {
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const rw = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
  const register = (name, title, description, inputSchema, annotations, handler) => server.registerTool(name, {
    title, description, inputSchema, outputSchema: z.object({}).passthrough(), annotations
  }, handler);

  register('codex_collaboration_status', 'Codex Collaboration status', 'Inspect the optional supervised Codex collaboration runtime and recent tasks.', z.object({}), ro,
    async () => toolText(codexCollaborationStatus()));
  register('codex_collaboration_configure', 'Configure Codex Collaboration', 'Turn supervised Codex collaboration on or off without changing other DevMate behavior.', z.object({ enabled: z.boolean() }), rw,
    async ({ enabled }) => {
      const result = configureCodexCollaboration(enabled);
      if (!enabled) await shutdownCodexRuntime();
      return toolText(result);
    });
  register('codex_task_start', 'Start Codex task', 'Delegate one engineering task to Codex inside an isolated DevMate snapshot.', z.object({
    workspaceId: z.string().min(1), title: z.string().max(MAX_TITLE).optional(), prompt: z.string().min(1).max(100_000)
  }), rw, async args => toolText({ task: publicTask(await startCodexTask(args)) }));
  register('codex_task_continue', 'Continue Codex task', 'Continue an existing Codex thread against the same isolated snapshot.', z.object({
    workspaceId: z.string().min(1), taskId: z.string().min(1), prompt: z.string().min(1).max(100_000)
  }), rw, async args => toolText({ task: publicTask(await continueCodexTask(args)) }));
  register('codex_task_steer', 'Steer Codex task', 'Steer the currently active Codex turn without creating a new thread.', z.object({
    workspaceId: z.string().min(1), taskId: z.string().min(1), prompt: z.string().min(1).max(20_000)
  }), rw, async args => toolText({ task: publicTask(await steerCodexTask(args)) }));
  register('codex_task_interrupt', 'Interrupt Codex task', 'Interrupt the currently active Codex turn and preserve resumable task state.', z.object({
    workspaceId: z.string().min(1), taskId: z.string().min(1)
  }), rw, async args => toolText(await interruptCodexTask(args)));
  register('codex_proposal_status', 'Codex proposal status', 'Review the snapshot changes proposed by a Codex task before applying them.', z.object({
    workspaceId: z.string().min(1), taskId: z.string().min(1)
  }), ro, async args => toolText(await codexProposal(args)));
  register('codex_proposal_apply', 'Apply Codex proposal', 'Apply a reviewed Codex snapshot proposal through DevMate transaction and conflict controls.', z.object({
    workspaceId: z.string().min(1), taskId: z.string().min(1)
  }), rw, async args => toolText(await applyCodexProposal(args)));
}

export function installCodexCollaborationCapability(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.codex-collaboration',
    order: 35,
    initialize: registerCodexTools
  });
}

export async function shutdownCodexCollaboration() {
  const state = readState();
  if (state.activeTaskId) {
    try {
      updateTask(state.activeTaskId, (task, current) => {
        task.status = 'interrupted';
        task.error = 'Gateway stopped while Codex task was active';
        releaseActive(current, task);
      });
    } catch {}
  }
  return shutdownCodexRuntime();
}

export function recoverCodexCollaborationAfterRestart() {
  mutateState(state => {
    for (const task of state.tasks) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      task.status = 'interrupted';
      task.error = 'Previous Gateway exited while Codex task was active';
      task.updatedAt = now();
    }
    state.activeTaskId = null;
    return true;
  });
}

recoverCodexCollaborationAfterRestart();

export const __test = {
  ACTIVE_STATUSES,
  CONTINUABLE_STATUSES,
  MAX_TASKS,
  captureActiveTurn,
  collaborationConfig,
  emptyState,
  normalizeState,
  publicTask,
  readState,
  registerCodexTools,
  reserveContinuation,
  reserveNewTask,
  writableWorkspace
};
