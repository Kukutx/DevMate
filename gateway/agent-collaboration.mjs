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
  readAgentBaselineFile,
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
const RUNTIME_ACTIVE_STATUSES = new Set(['preparing', 'running']);
const APPLY_ACTIVE_STATUSES = new Set(['applying', 'rolling_back', 'recovery_blocked']);
const ACTIVE_STATUSES = new Set([...RUNTIME_ACTIVE_STATUSES, ...APPLY_ACTIVE_STATUSES]);
const CONTINUABLE_STATUSES = new Set(['proposal_ready', 'completed', 'failed', 'interrupted']);
const TASK_STATUSES = new Set([...ACTIVE_STATUSES, ...CONTINUABLE_STATUSES, 'applied']);
const APPLY_CHANGE_KINDS = new Set(['create', 'modify', 'delete']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_TASKS = 20;
const MAX_TITLE = 200;
const MAX_OUTPUT = 20_000;
let collaborationEpoch = 0;

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

function invalidCollaborationState(message, detail = {}) {
  return codedError(
    `Codex collaboration durable state is invalid: ${message}`,
    'codex_collaboration_state_invalid',
    detail
  );
}

function validNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateApplyChange(change, taskId, index) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    throw invalidCollaborationState(`task ${taskId} apply change ${index} must be an object`, { taskId, changeIndex: index });
  }
  if (!validNonEmptyString(change.path) || change.path.includes('\0')) {
    throw invalidCollaborationState(`task ${taskId} apply change ${index} has an invalid path`, { taskId, changeIndex: index });
  }
  if (!APPLY_CHANGE_KINDS.has(change.kind)) {
    throw invalidCollaborationState(`task ${taskId} apply change ${index} has an invalid kind`, { taskId, changeIndex: index });
  }
  const beforeValid = change.beforeSha256 == null || (typeof change.beforeSha256 === 'string' && SHA256_PATTERN.test(change.beforeSha256));
  const afterValid = change.afterSha256 == null || (typeof change.afterSha256 === 'string' && SHA256_PATTERN.test(change.afterSha256));
  if (!beforeValid || !afterValid) {
    throw invalidCollaborationState(`task ${taskId} apply change ${index} has an invalid content digest`, { taskId, changeIndex: index });
  }
  if (change.kind === 'create' && (change.beforeSha256 !== null || !SHA256_PATTERN.test(String(change.afterSha256 || '')))) {
    throw invalidCollaborationState(`task ${taskId} create change ${index} has inconsistent digests`, { taskId, changeIndex: index });
  }
  if (change.kind === 'modify' && (!SHA256_PATTERN.test(String(change.beforeSha256 || '')) || !SHA256_PATTERN.test(String(change.afterSha256 || '')))) {
    throw invalidCollaborationState(`task ${taskId} modify change ${index} has inconsistent digests`, { taskId, changeIndex: index });
  }
  if (change.kind === 'delete' && (!SHA256_PATTERN.test(String(change.beforeSha256 || '')) || change.afterSha256 !== null)) {
    throw invalidCollaborationState(`task ${taskId} delete change ${index} has inconsistent digests`, { taskId, changeIndex: index });
  }
}

function validateApplyState(task, taskIndex) {
  const apply = task.apply;
  if (!apply || typeof apply !== 'object' || Array.isArray(apply)) {
    throw invalidCollaborationState(`active apply task ${task.id} is missing its recovery transaction`, { taskId: task.id, taskIndex });
  }
  if (apply.version !== 1 || apply.status !== task.status || !Array.isArray(apply.changes) || !apply.changes.length) {
    throw invalidCollaborationState(`active apply task ${task.id} has malformed transaction metadata`, { taskId: task.id, taskIndex });
  }
  if (!Number.isSafeInteger(apply.appliedCount) || apply.appliedCount < 0 || apply.appliedCount > apply.changes.length) {
    throw invalidCollaborationState(`active apply task ${task.id} has an invalid appliedCount`, { taskId: task.id, taskIndex });
  }
  if (
    apply.inFlightIndex !== null &&
    (!Number.isSafeInteger(apply.inFlightIndex) || apply.inFlightIndex < 0 || apply.inFlightIndex >= apply.changes.length)
  ) {
    throw invalidCollaborationState(`active apply task ${task.id} has an invalid inFlightIndex`, { taskId: task.id, taskIndex });
  }
  if (!Array.isArray(apply.recoveryFailures)) {
    throw invalidCollaborationState(`active apply task ${task.id} has invalid recoveryFailures`, { taskId: task.id, taskIndex });
  }
  apply.changes.forEach((change, changeIndex) => validateApplyChange(change, task.id, changeIndex));
}

function normalizeState(raw) {
  // A missing namespace is the only case that is safe to initialize. Existing
  // malformed state must remain intact and stop recovery rather than silently
  // discarding task/apply evidence.
  if (raw === undefined) return emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidCollaborationState('root must be an object');
  }
  if (raw.version !== 1) {
    throw invalidCollaborationState(`unsupported version ${String(raw.version)}`, { stateVersion: raw.version ?? null });
  }
  if (!Array.isArray(raw.tasks)) throw invalidCollaborationState('tasks must be an array');
  if (raw.tasks.length > MAX_TASKS) {
    throw invalidCollaborationState(`task history exceeds the ${MAX_TASKS} task limit`, { taskCount: raw.tasks.length });
  }

  const ids = new Set();
  const tasks = raw.tasks.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidCollaborationState(`task ${index} must be an object`, { taskIndex: index });
    }
    if (!validNonEmptyString(item.id) || !validNonEmptyString(item.workspaceId)) {
      throw invalidCollaborationState(`task ${index} is missing identity`, { taskIndex: index });
    }
    if (ids.has(item.id)) throw invalidCollaborationState(`duplicate task id ${item.id}`, { taskId: item.id, taskIndex: index });
    ids.add(item.id);
    if (!TASK_STATUSES.has(item.status)) {
      throw invalidCollaborationState(`task ${item.id} has unsupported status ${String(item.status)}`, { taskId: item.id, taskIndex: index });
    }
    if (APPLY_ACTIVE_STATUSES.has(item.status)) validateApplyState(item, index);
    else if (item.apply != null) {
      throw invalidCollaborationState(`inactive task ${item.id} retains an apply transaction`, { taskId: item.id, taskIndex: index });
    }
    return item;
  });

  if (raw.activeTaskId !== null && !validNonEmptyString(raw.activeTaskId)) {
    throw invalidCollaborationState('activeTaskId must be null or a non-empty task id');
  }
  const activeTasks = tasks.filter(item => ACTIVE_STATUSES.has(item.status));
  if (activeTasks.length > 1) {
    throw invalidCollaborationState('more than one task is active', { activeTaskIds: activeTasks.map(item => item.id) });
  }
  if (!activeTasks.length && raw.activeTaskId !== null) {
    throw invalidCollaborationState(`activeTaskId ${raw.activeTaskId} does not reference an active task`, { activeTaskId: raw.activeTaskId });
  }
  if (activeTasks.length === 1 && raw.activeTaskId !== activeTasks[0].id) {
    throw invalidCollaborationState(`active task ${activeTasks[0].id} does not match activeTaskId`, {
      activeTaskId: raw.activeTaskId,
      taskId: activeTasks[0].id
    });
  }
  return { version: 1, activeTaskId: raw.activeTaskId, tasks };
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

function publicApply(apply) {
  if (!apply) return null;
  return {
    status: apply.status || null,
    startedAt: apply.startedAt || null,
    updatedAt: apply.updatedAt || null,
    changeCount: Array.isArray(apply.changes) ? apply.changes.length : 0,
    appliedCount: Number.isInteger(apply.appliedCount) ? apply.appliedCount : 0,
    inFlightIndex: Number.isInteger(apply.inFlightIndex) ? apply.inFlightIndex : null,
    recoveryFailures: Array.isArray(apply.recoveryFailures) ? clone(apply.recoveryFailures).slice(0, 100) : []
  };
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
    snapshotAvailable: task.snapshotAvailable === true,
    snapshotCleanupPending: task.snapshotCleanupPending === true,
    apply: publicApply(task.apply)
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

function captureEnabledEpoch() {
  requireEnabled();
  return collaborationEpoch;
}

function requireEnabledEpoch(epoch) {
  const enabled = collaborationConfig().enabled;
  if (epoch === collaborationEpoch && enabled) return;
  if (!enabled) throw codedError('Codex Collaboration was turned OFF while the task was active.', 'codex_collaboration_disabled');
  throw codedError('Codex task was interrupted by the supervisor while it was active.', 'codex_task_interrupted');
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
      snapshotAvailable: false,
      snapshotCleanupPending: false,
      apply: null
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
    if (!CONTINUABLE_STATUSES.has(task.status)) throw codedError(`Codex task cannot continue from status ${task.status}`, 'codex_task_not_resumable');
    if (!task.threadId) throw codedError('Codex task has no resumable thread state', 'codex_task_not_resumable');
    if (!task.snapshotAvailable && task.status !== 'completed') throw codedError('Codex task has no resumable snapshot state', 'codex_task_not_resumable');
    task.status = 'preparing';
    task.error = null;
    task.turnId = null;
    task.turnStatus = null;
    task.apply = null;
    task.updatedAt = now();
    state.activeTaskId = task.id;
    return clone(task);
  });
}

function markFailure(taskId, error) {
  try {
    return updateTask(taskId, (task, state) => {
      if (APPLY_ACTIVE_STATUSES.has(task.status)) return;
      task.status = ['codex_turn_idle_timeout', 'codex_turn_timeout', 'codex_transport_closed', 'codex_stopped', 'codex_collaboration_disabled', 'codex_task_interrupted'].includes(error?.code)
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

async function stopCodexRuntimeConfirmed(context, attempts = 2) {
  let last = null;
  let lastError = null;
  const count = Math.max(1, Math.min(3, Number(attempts) || 2));
  for (let attempt = 0; attempt < count; attempt += 1) {
    try {
      last = await shutdownCodexRuntime();
      if (last?.exitConfirmed !== false) return last;
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < count) await delay(100);
  }
  throw codedError(`Could not confirm Codex app-server exit while ${context}`, 'codex_stop_unconfirmed', {
    termination: last ? clone(last) : null,
    stopError: lastError ? String(lastError?.message || lastError).slice(0, 2000) : null
  });
}

async function cleanupTaskSnapshot(taskId) {
  try {
    await removeAgentSnapshot(taskId);
    updateTask(taskId, task => {
      task.snapshotAvailable = false;
      task.snapshotCleanupPending = false;
    });
    return true;
  } catch (error) {
    updateTask(taskId, task => {
      task.snapshotCleanupPending = true;
      task.error ||= `Snapshot cleanup pending: ${String(error?.message || error).slice(0, 1000)}`;
    });
    return false;
  }
}

function proposalDigest(proposal) {
  const canonical = {
    taskId: proposal?.taskId || null,
    workspaceId: proposal?.workspaceId || null,
    changes: Array.isArray(proposal?.changes) ? proposal.changes : [],
    blocked: Array.isArray(proposal?.blocked) ? proposal.blocked : []
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

async function finalizeTurn(taskId, result) {
  const proposal = await agentProposalChanges(taskId);
  const digest = proposalDigest(proposal);
  const hasChanges = proposal.changes.length > 0 || proposal.blocked.length > 0;
  const failedTurn = ['failed', 'interrupted', 'cancelled'].includes(String(result.status || '').toLowerCase());
  const updated = updateTask(taskId, (task, state) => {
    task.turnId = result.turnId;
    task.turnStatus = result.status;
    task.output = String(result.output || '').slice(-MAX_OUTPUT);
    task.proposal = {
      digest,
      changeCount: proposal.changes.length,
      blockedCount: proposal.blocked.length,
      changes: proposal.changes.slice(0, 500),
      blocked: proposal.blocked.slice(0, 500)
    };
    task.completedAt = now();
    task.status = hasChanges ? 'proposal_ready' : failedTurn ? 'failed' : 'completed';
    task.apply = null;
    if (failedTurn && result.error) task.error = String(result.error).slice(0, 4000);
    releaseActive(state, task);
  });
  if (!hasChanges && !failedTurn) await cleanupTaskSnapshot(taskId);
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

async function executeTurn({ task, workspace, prompt, epoch }) {
  const runtime = codexRuntime();
  try {
    requireEnabledEpoch(epoch);
    if (!task.snapshotAvailable) {
      await createAgentSnapshot({ taskId: task.id, workspace });
      updateTask(task.id, current => { current.snapshotAvailable = true; });
    } else {
      await readAgentSnapshotManifest(task.id);
    }
    requireEnabledEpoch(epoch);
    const cwd = path.join(AGENT_TASK_ROOT, task.id, 'workspace');
    const thread = await runtime.ensureThread({ threadId: task.threadId || '', cwd });
    requireEnabledEpoch(epoch);
    updateTask(task.id, current => {
      current.threadId = thread.threadId;
      current.status = 'running';
      current.error = null;
    });

    const turnPromise = runtime.runTurn({ threadId: thread.threadId, cwd, prompt });
    await captureActiveTurn(task.id, runtime, thread.threadId, turnPromise);
    requireEnabledEpoch(epoch);
    const result = await turnPromise;
    requireEnabledEpoch(epoch);
    return finalizeTurn(task.id, result);
  } catch (error) {
    if (error?.code === 'codex_collaboration_disabled' || error?.code === 'codex_task_interrupted') {
      await stopCodexRuntimeConfirmed('cancelling an active task').catch(stopError => { throw stopError; });
    }
    markFailure(task.id, error);
    throw error;
  }
}

export async function startCodexTask({ workspaceId, title = '', prompt }) {
  const epoch = captureEnabledEpoch();
  const config = readConfig();
  const workspace = writableWorkspace(config, workspaceId);
  const task = reserveNewTask({ workspaceId: workspace.id, title });
  return executeTurn({ task, workspace, prompt, epoch });
}

export async function continueCodexTask({ workspaceId, taskId, prompt }) {
  const epoch = captureEnabledEpoch();
  const config = readConfig();
  const workspace = writableWorkspace(config, workspaceId);
  const task = reserveContinuation(taskId, workspace.id);
  return executeTurn({ task, workspace, prompt, epoch });
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
  if (APPLY_ACTIVE_STATUSES.has(task.status)) throw codedError('Codex proposal apply/recovery cannot be interrupted mid-transaction', 'codex_apply_active');
  if (!RUNTIME_ACTIVE_STATUSES.has(task.status)) throw codedError('Codex task has no active turn/preparation to interrupt', 'codex_turn_not_active');

  collaborationEpoch += 1;
  let interruptResult = { interrupted: false };
  if (task.threadId && task.turnId) {
    try { interruptResult = await codexRuntime().interrupt(task.threadId, task.turnId); }
    catch (error) { interruptResult = { interrupted: false, error: String(error?.message || error).slice(0, 1000) }; }
  }
  const stopped = await stopCodexRuntimeConfirmed(`interrupting Codex task ${task.id}`);
  const updated = updateTask(task.id, (current, currentState) => {
    current.status = 'interrupted';
    current.error = 'Interrupted by supervisor';
    current.turnStatus = null;
    releaseActive(currentState, current);
  });
  return { task: publicTask(updated), runtime: { ...interruptResult, stop: stopped } };
}

export async function codexProposal({ workspaceId, taskId }) {
  const state = readState();
  const task = taskById(state, taskId);
  if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
  if (task.workspaceId !== workspaceId) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
  if (!task.snapshotAvailable) return { task: publicTask(task), proposalDigest: null, changes: [], blocked: [] };
  const proposal = await agentProposalChanges(task.id);
  return { task: publicTask(task), proposalDigest: proposalDigest(proposal), ...proposal };
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

async function classifyWorkspaceChange(workspaceRoot, change) {
  try {
    await assertAgentProposalConflictFree({ workspaceRoot, change });
    return 'before';
  } catch {}
  const afterProbe = change.kind === 'delete'
    ? { ...change, kind: 'create', beforeSha256: null, afterSha256: null }
    : { ...change, kind: 'modify', beforeSha256: change.afterSha256 };
  try {
    await assertAgentProposalConflictFree({ workspaceRoot, change: afterProbe });
    return 'after';
  } catch {
    return 'unknown';
  }
}

function reserveApply(taskId, workspaceId, changes) {
  return mutateState(state => {
    if (state.activeTaskId && state.activeTaskId !== taskId) {
      throw codedError(`Codex task ${state.activeTaskId} is already active`, 'codex_task_active');
    }
    const task = taskById(state, taskId);
    if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
    if (task.workspaceId !== workspaceId) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
    if (task.status !== 'proposal_ready' || !task.snapshotAvailable || task.apply) {
      throw codedError(`Codex proposal is not ready from status ${task.status}`, 'codex_proposal_not_ready');
    }
    const timestamp = now();
    task.status = 'applying';
    task.error = null;
    task.apply = {
      version: 1,
      status: 'applying',
      startedAt: timestamp,
      updatedAt: timestamp,
      changes: clone(changes),
      appliedCount: 0,
      inFlightIndex: null,
      recoveryFailures: []
    };
    state.activeTaskId = task.id;
    return clone(task);
  });
}

function updateApplyProgress(taskId, updater) {
  return updateTask(taskId, task => {
    if (!task.apply || !APPLY_ACTIVE_STATUSES.has(task.status)) {
      throw codedError('Codex apply transaction state is unavailable', 'codex_apply_state_invalid');
    }
    updater(task.apply, task);
    task.apply.updatedAt = now();
  });
}

async function applyOneChange(taskId, workspace, change) {
  const create = safeFileMutationHandler('create_file');
  const write = safeFileMutationHandler('write_file');
  const remove = safeFileMutationHandler('delete_file');
  if (change.kind === 'create') {
    const content = await readAgentProposalFile(taskId, change.path);
    if (sha256Text(content) !== change.afterSha256) throw codedError(`Codex proposal changed while applying: ${change.path}`, 'codex_proposal_changed');
    await create({ workspaceId: workspace.id, path: change.path, content, overwrite: false, createDirs: true, mode: change.mode ?? null });
  } else if (change.kind === 'modify') {
    const content = await readAgentProposalFile(taskId, change.path);
    if (sha256Text(content) !== change.afterSha256) throw codedError(`Codex proposal changed while applying: ${change.path}`, 'codex_proposal_changed');
    await write({
      workspaceId: workspace.id,
      path: change.path,
      content,
      append: false,
      createDirs: false,
      expectedSha256: change.beforeSha256
    });
  } else if (change.kind === 'delete') {
    await remove({ workspaceId: workspace.id, path: change.path, recursive: false, expectedSha256: change.beforeSha256 });
  } else {
    throw codedError(`Unsupported Codex proposal change kind: ${change.kind}`, 'codex_proposal_invalid');
  }
  if (await classifyWorkspaceChange(workspace.root, change) !== 'after') {
    throw codedError(`Codex proposal mutation could not be verified after apply: ${change.path}`, 'codex_proposal_apply_verify_failed');
  }
}

async function rollbackOneChange(taskId, workspace, change) {
  const create = safeFileMutationHandler('create_file');
  const write = safeFileMutationHandler('write_file');
  const remove = safeFileMutationHandler('delete_file');
  const state = await classifyWorkspaceChange(workspace.root, change);
  if (state === 'before') return { restored: false, alreadyBefore: true };
  if (state !== 'after') throw codedError(`Workspace diverged while recovering Codex apply: ${change.path}`, 'codex_apply_recovery_conflict', { path: change.path });

  if (change.kind === 'create') {
    await remove({ workspaceId: workspace.id, path: change.path, recursive: false, expectedSha256: change.afterSha256 });
  } else {
    const baseline = await readAgentBaselineFile(taskId, change.path);
    if (change.kind === 'modify') {
      await write({
        workspaceId: workspace.id,
        path: change.path,
        content: baseline.text,
        append: false,
        createDirs: false,
        expectedSha256: change.afterSha256
      });
    } else if (change.kind === 'delete') {
      await create({
        workspaceId: workspace.id,
        path: change.path,
        content: baseline.text,
        overwrite: false,
        createDirs: true,
        mode: baseline.mode
      });
    }
  }
  if (await classifyWorkspaceChange(workspace.root, change) !== 'before') {
    throw codedError(`Codex apply rollback could not verify restored state: ${change.path}`, 'codex_apply_recovery_verify_failed', { path: change.path });
  }
  return { restored: true, alreadyBefore: false };
}

async function rollbackApplyTransaction(taskId, workspace, { strictInFlight = true, reason = 'Codex apply was rolled back' } = {}) {
  const current = taskById(readState(), taskId);
  if (!current?.apply || !Array.isArray(current.apply.changes)) {
    throw codedError('Codex apply transaction state is unavailable', 'codex_apply_state_invalid');
  }
  updateApplyProgress(taskId, (apply, task) => {
    apply.status = 'rolling_back';
    task.status = 'rolling_back';
  });

  const apply = taskById(readState(), taskId).apply;
  const indexes = [];
  for (let index = 0; index < Math.min(apply.appliedCount || 0, apply.changes.length); index += 1) indexes.push(index);
  if (Number.isInteger(apply.inFlightIndex) && apply.inFlightIndex >= 0 && apply.inFlightIndex < apply.changes.length && !indexes.includes(apply.inFlightIndex)) {
    indexes.push(apply.inFlightIndex);
  }
  indexes.sort((a, b) => b - a);
  const failures = [];

  for (const index of indexes) {
    const change = apply.changes[index];
    try {
      const state = await classifyWorkspaceChange(workspace.root, change);
      const definitelyApplied = index < (apply.appliedCount || 0);
      if (state === 'before') continue;
      if (state === 'unknown' && !definitelyApplied && !strictInFlight) continue;
      if (state === 'unknown') throw codedError(`Workspace state is ambiguous for ${change.path}`, 'codex_apply_recovery_conflict');
      await rollbackOneChange(taskId, workspace, change);
    } catch (error) {
      failures.push({ index, path: change.path, code: error?.code || null, error: String(error?.message || error).slice(0, 1000) });
    }
  }

  if (failures.length) {
    updateApplyProgress(taskId, (next, task) => {
      next.status = 'recovery_blocked';
      next.recoveryFailures = failures;
      task.status = 'recovery_blocked';
      task.error = `Codex apply recovery is blocked for ${failures.length} change(s)`;
    });
    return { recovered: false, blocked: failures };
  }

  const updated = updateTask(taskId, (task, state) => {
    task.status = 'proposal_ready';
    task.error = reason;
    task.apply = null;
    releaseActive(state, task);
  });
  return { recovered: true, blocked: [], task: publicTask(updated) };
}

export async function applyCodexProposal({ workspaceId, taskId, expectedProposalDigest }) {
  requireEnabled();
  const expected = String(expectedProposalDigest || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) throw codedError('A reviewed expectedProposalDigest is required to apply a Codex proposal', 'codex_proposal_digest_required');
  const config = readConfig();
  const workspace = writableWorkspace(config, workspaceId);
  const state = readState();
  const task = taskById(state, taskId);
  if (!task) throw codedError(`Codex task not found: ${taskId}`, 'codex_task_not_found');
  if (task.workspaceId !== workspace.id) throw codedError('Codex task belongs to a different workspace', 'codex_task_workspace_mismatch');
  if (task.status !== 'proposal_ready' || !task.snapshotAvailable || task.apply) throw codedError(`Codex proposal is not ready from status ${task.status}`, 'codex_proposal_not_ready');

  const proposal = await agentProposalChanges(task.id);
  const currentDigest = proposalDigest(proposal);
  if (currentDigest !== expected) {
    throw codedError('Codex proposal changed after review; inspect the proposal again before applying it', 'codex_proposal_review_stale', {
      expectedProposalDigest: expected,
      currentProposalDigest: currentDigest
    });
  }
  if (proposal.blocked.length) {
    throw codedError(`Codex proposal contains ${proposal.blocked.length} blocked change(s)`, 'codex_proposal_blocked', { blocked: proposal.blocked.slice(0, 100) });
  }
  if (!proposal.changes.length) throw codedError('Codex proposal has no changes to apply', 'codex_proposal_empty');

  for (const change of proposal.changes) await assertAgentProposalConflictFree({ workspaceRoot: workspace.root, change });
  reserveApply(task.id, workspace.id, proposal.changes);

  try {
    for (let index = 0; index < proposal.changes.length; index += 1) {
      updateApplyProgress(task.id, apply => { apply.inFlightIndex = index; });
      await applyOneChange(task.id, workspace, proposal.changes[index]);
      updateApplyProgress(task.id, apply => {
        apply.appliedCount = index + 1;
        apply.inFlightIndex = null;
      });
    }
  } catch (error) {
    const rollback = await rollbackApplyTransaction(task.id, workspace, {
      strictInFlight: false,
      reason: `Codex proposal apply failed and applied changes were rolled back: ${String(error?.message || error).slice(0, 2000)}`
    });
    if (!rollback.recovered) {
      throw codedError(
        `Codex proposal apply failed and recovery is blocked for ${rollback.blocked.length} change(s)`,
        'codex_proposal_recovery_blocked',
        { cause: error, recoveryFailures: rollback.blocked }
      );
    }
    throw codedError(`Codex proposal apply failed and completed changes were rolled back: ${error?.message || error}`, 'codex_proposal_apply_failed', { cause: error });
  }

  const updated = updateTask(task.id, (current, currentState) => {
    current.status = 'applied';
    current.appliedAt = now();
    current.apply = null;
    current.error = null;
    current.proposal = {
      digest: currentDigest,
      changeCount: proposal.changes.length,
      blockedCount: 0,
      changes: proposal.changes.slice(0, 500),
      blocked: []
    };
    releaseActive(currentState, current);
  });
  await cleanupTaskSnapshot(task.id);
  return { task: publicTask(updated), proposalDigest: currentDigest, applied: proposal.changes.map(item => ({ kind: item.kind, path: item.path })) };
}

export async function configureCodexCollaboration(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const previous = collaborationConfig().enabled;
  const config = previous === enabled
    ? readConfig()
    : mutateConfig(current => {
        current.agent ||= {};
        current.agent.codexCollaborationEnabled = enabled;
        return current;
      });
  if (previous !== enabled) collaborationEpoch += 1;
  if (!enabled) {
    await stopCodexRuntimeConfirmed('turning Codex Collaboration OFF');
    mutateState(state => {
      for (const task of state.tasks) {
        if (!RUNTIME_ACTIVE_STATUSES.has(task.status)) continue;
        task.status = 'interrupted';
        task.error = 'Codex Collaboration was turned OFF';
        task.turnStatus = null;
        task.updatedAt = now();
        releaseActive(state, task);
      }
      return true;
    });
  }
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
      applyRequiresProposalDigest: true,
      applyCrashRecovery: true,
      parentDeathFenced: true,
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
    async ({ enabled }) => toolText(await configureCodexCollaboration(enabled)));
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
  register('codex_proposal_apply', 'Apply Codex proposal', 'Apply exactly the reviewed Codex snapshot proposal through DevMate transaction and conflict controls.', z.object({
    workspaceId: z.string().min(1), taskId: z.string().min(1), expectedProposalDigest: z.string().regex(/^[a-fA-F0-9]{64}$/)
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
  const stopped = await stopCodexRuntimeConfirmed('shutting down the Gateway', 3);
  const state = readState();
  if (state.activeTaskId) {
    const active = taskById(state, state.activeTaskId);
    if (active && RUNTIME_ACTIVE_STATUSES.has(active.status)) {
      updateTask(active.id, (task, current) => {
        task.status = 'interrupted';
        task.error = 'Gateway stopped while Codex task was active';
        task.turnStatus = null;
        releaseActive(current, task);
      });
    }
  }
  return stopped;
}

export function recoverCodexCollaborationAfterRestart() {
  mutateState(state => {
    for (const task of state.tasks) {
      if (!RUNTIME_ACTIVE_STATUSES.has(task.status)) continue;
      task.status = 'interrupted';
      task.error = 'Previous Gateway exited while Codex task was active';
      task.updatedAt = now();
      releaseActive(state, task);
    }
    return true;
  });
}

export async function recoverCodexApplyAfterFileTransactions() {
  const config = readConfig();
  const state = readState();
  const recovered = [];
  const blocked = [];
  for (const task of state.tasks) {
    if (!APPLY_ACTIVE_STATUSES.has(task.status) || !task.apply) continue;
    let workspace;
    try {
      workspace = writableWorkspace(config, task.workspaceId);
      const result = await rollbackApplyTransaction(task.id, workspace, {
        strictInFlight: true,
        reason: 'Previous Gateway exited during Codex proposal apply; the workspace was restored to the pre-apply snapshot state'
      });
      if (result.recovered) recovered.push({ taskId: task.id });
      else blocked.push({ taskId: task.id, failures: result.blocked });
    } catch (error) {
      const failure = { taskId: task.id, code: error?.code || null, error: String(error?.message || error).slice(0, 2000) };
      blocked.push(failure);
      try {
        updateApplyProgress(task.id, (apply, current) => {
          apply.status = 'recovery_blocked';
          apply.recoveryFailures = [failure];
          current.status = 'recovery_blocked';
          current.error = `Codex apply recovery is blocked: ${failure.error}`;
        });
      } catch {}
    }
  }
  return { recovered, blocked };
}

export const __test = {
  ACTIVE_STATUSES,
  APPLY_ACTIVE_STATUSES,
  CONTINUABLE_STATUSES,
  MAX_TASKS,
  RUNTIME_ACTIVE_STATUSES,
  captureActiveTurn,
  classifyWorkspaceChange,
  collaborationConfig,
  emptyState,
  normalizeState,
  proposalDigest,
  publicTask,
  readState,
  registerCodexTools,
  reserveApply,
  reserveContinuation,
  reserveNewTask,
  rollbackApplyTransaction,
  stopCodexRuntimeConfirmed,
  updateApplyProgress,
  writableWorkspace
};
