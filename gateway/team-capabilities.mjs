import { z } from 'zod';
import { audit, mutateConfig, readConfig, redactSensitiveString } from './local-shared.mjs';
import {
  conversationScopeFromToolContext,
  requestContext,
  requestConversationScope,
  runWithConversationScope,
  runWithRequestSignal,
  runWithWorkSessionContext
} from './request-context.mjs';
import {
  assertConversationWorkspaceMatch,
  bindConversationWorkspaceToWorkspace,
  conversationWorkspace
} from './conversation-workspaces.mjs';
import { authorizeToolCall, normalizeInstanceConfig } from './team-access.mjs';
import { listPersistentProcesses } from './persistent-processes.mjs';
import { getPreview } from './plugins/preview-manager.mjs';
import { activeWorkSession, touchWorkSession } from './work-sessions.mjs';
import {
  acquireWorkspaceLeaseHold,
  assertWorkspaceLease,
  releaseWorkspaceLeaseHold
} from './workspace-leases.mjs';
import { clearPreviewShares } from './published-previews.mjs';
import { ensureToolApproval } from './approvals.mjs';
import { registerApprovalTools } from './approval-tools.mjs';
import { assertDrainAllows } from './job-queue.mjs';
import { registerJobTarget } from './job-runtime.mjs';
import { registerJobTools } from './job-tools.mjs';
import { incrementCounter, observeDuration } from './observability.mjs';
import { registerServerInitializer, registerToolDecorator } from './server-extension-host.mjs';
import { registerTeamManagementTools } from './team-management-tools.mjs';
import { registerTeamCollaborationTools } from './team-collaboration-tools.mjs';
import { workspaceScopedTool } from './tool-policy.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';
import {
  cleanOrigin,
  principalNow,
  publicDeployment,
  readiness,
  workspaceIds
} from './team-tool-data.mjs';

const REGISTERED = Symbol.for('devmate.teamToolsRegistered');

export function registerTeamTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;
  const register = (name, config, handler) => server.registerTool(name, {
    outputSchema: z.object({}).passthrough(),
    ...config
  }, handler);
  const annotations = {
    ro: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rw: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  };
  registerTeamManagementTools(register, annotations);
  registerTeamCollaborationTools(register, annotations);
  registerApprovalTools(register, annotations);
  registerJobTools(register, annotations);
}

function inferredWorkspace(name, args = {}) {
  if (['process_status', 'read_process_output', 'send_process_input', 'stop_process'].includes(name) && args.id) {
    return listPersistentProcesses(true).find(item => item.id === args.id)?.workspaceId || null;
  }
  if (['web_preview_status', 'web_preview_stop'].includes(name) && args.id) {
    try { return getPreview(args.id)?.workspaceId || null; }
    catch { return null; }
  }
  return null;
}

function bindAuthorizedWorkspaceArgs(args, authorized) {
  const workspaceId = String(authorized?.workspaceId || '').trim();
  if (!workspaceId || String(args?.workspaceId || '').trim()) return args;
  return { ...args, workspaceId };
}

function filterArray(items, allowed, field = 'workspaceId') {
  return Array.isArray(items) ? items.filter(item => allowed.has(item?.[field] || item?.id)) : items;
}

function syncTextContent(result) {
  if (!Array.isArray(result?.content) || !result?.structuredContent) return result;
  const json = JSON.stringify(result.structuredContent, null, 2);
  for (const item of result.content) if (item?.type === 'text') item.text = json;
  return result;
}

function commandResultFailed(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.timedOut === true || value.error || value.signal || value.exitConfirmed === false) return true;
  return value.exitCode != null && Number(value.exitCode) !== 0;
}

function failedGitPhase(name, data) {
  const tool = String(name || '');
  if (!tool.startsWith('git_') || !data || typeof data !== 'object') return '';
  if (tool === 'git_save') {
    for (const phase of ['stage', 'commit', 'push', 'status']) if (commandResultFailed(data[phase])) return phase;
    return '';
  }
  if (tool === 'git_commit') {
    for (const phase of ['stage', 'commit', 'status']) if (commandResultFailed(data[phase])) return phase;
    return '';
  }
  if (tool === 'git_add' || tool === 'git_stage') {
    for (const phase of ['stage', 'status']) if (commandResultFailed(data[phase])) return phase;
    return '';
  }
  return commandResultFailed(data) ? 'command' : '';
}

function markGitFailure(name, result) {
  const data = result?.structuredContent;
  const failedPhase = failedGitPhase(name, data);
  if (!failedPhase) return result;
  data.ok = false;
  data.failedPhase = failedPhase;
  result.isError = true;
  return syncTextContent(result);
}

function redactCommandResultPayload(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) redactCommandResultPayload(item, seen);
    return value;
  }
  const commandShape = typeof value.command === 'string' && (
    Object.hasOwn(value, 'exitCode') || Object.hasOwn(value, 'timedOut') ||
    Object.hasOwn(value, 'stdout') || Object.hasOwn(value, 'stderr')
  );
  if (commandShape) {
    for (const key of ['command', 'stdout', 'stderr', 'error']) {
      if (typeof value[key] === 'string') value[key] = redactSensitiveString(value[key]);
    }
  }
  for (const child of Object.values(value)) redactCommandResultPayload(child, seen);
  return value;
}

function redactProcessOutputEvents(name, value) {
  if (name !== 'read_process_output' || !Array.isArray(value?.events)) return value;
  for (const event of value.events) if (typeof event?.text === 'string') event.text = redactSensitiveString(event.text);
  return value;
}

function sanitizeResultPayload(name, value) {
  redactCommandResultPayload(value);
  redactProcessOutputEvents(name, value);
  return value;
}

function sanitizeToolResult(name, result) {
  if (!result || typeof result !== 'object') return result;
  if (result.structuredContent) sanitizeResultPayload(name, result.structuredContent);
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type !== 'text' || typeof item.text !== 'string') continue;
      try {
        const parsed = JSON.parse(item.text);
        sanitizeResultPayload(name, parsed);
        item.text = JSON.stringify(parsed, null, 2);
      } catch {
        item.text = redactSensitiveString(item.text);
      }
    }
  }
  return result;
}

function filterResult(name, result, principal, authorizedWorkspaceId = null) {
  if (!result?.structuredContent) return sanitizeToolResult(name, result);
  const scopedData = result.structuredContent;
  if (authorizedWorkspaceId && name === 'list_processes' && Array.isArray(scopedData.processes)) {
    scopedData.processes = scopedData.processes.filter(item => item.workspaceId === authorizedWorkspaceId);
    scopedData.running = scopedData.processes.filter(item => ['running', 'stopping'].includes(item.status)).length;
    syncTextContent(result);
  }
  if (authorizedWorkspaceId && name === 'web_preview_status' && Array.isArray(scopedData.previews)) {
    scopedData.previews = scopedData.previews.filter(item => item.workspaceId === authorizedWorkspaceId);
    syncTextContent(result);
  }
  if (principal?.workspaceIds?.length) {
    const allowed = new Set(principal.workspaceIds);
    const data = result.structuredContent;
    if (['list_workspaces', 'gateway_status'].includes(name)) {
      data.workspaces = filterArray(data.workspaces, allowed, 'id');
      if (data.activeWorkspace && !allowed.has(data.activeWorkspace.id)) data.activeWorkspace = null;
      if (data.activeWorkspaceId && !allowed.has(data.activeWorkspaceId)) data.activeWorkspaceId = null;
    }
    if (['connection_diagnostics', 'devmate_status_panel'].includes(name) && data.workspace) {
      if (data.workspace.active && !allowed.has(data.workspace.active.id)) data.workspace.active = null;
      data.workspace.count = allowed.size;
      data.workspace.references = 0;
      if (name === 'devmate_status_panel' && result._meta?.diagnostics) result._meta.diagnostics = data;
    }
    if (name === 'list_processes') {
      data.processes = filterArray(data.processes, allowed);
      data.running = Array.isArray(data.processes) ? data.processes.filter(item => ['running', 'stopping'].includes(item.status)).length : 0;
    }
    if (name === 'web_preview_status') {
      data.previews = filterArray(data.previews, allowed);
      if (data.preview && !allowed.has(data.preview.workspaceId)) data.preview = null;
    }
    if (name === 'local_capabilities_status') {
      data.trustedWritableRoots = filterArray(data.trustedWritableRoots, allowed, 'id');
      data.persistentProcesses = filterArray(data.persistentProcesses, allowed);
    }
    if (name === 'list_trusted_roots') data.roots = filterArray(data.roots, allowed, 'id');
    syncTextContent(result);
  }
  return sanitizeToolResult(name, result);
}

function defaultConversationWorkspace(current) {
  const workspaces = Array.isArray(current?.workspaces) ? current.workspaces : [];
  return workspaces.find(item => item?.id === current?.activeWorkspaceId && !item.reference && item.mode !== 'readonly')
    || workspaces.find(item => item && !item.reference && item.mode !== 'readonly')
    || workspaces[0]
    || null;
}

function persistDefaultConversationBinding(scope, workspace) {
  if (!scope || !workspace) return null;
  let result = null;
  mutateConfig(config => {
    normalizeInstanceConfig(config);
    const existing = conversationWorkspace(config, scope);
    if (existing) { result = existing; return config; }
    result = bindConversationWorkspaceToWorkspace(config, scope, workspace, { source: 'default' });
    return config;
  }, { retries: 4 });
  return result;
}

function prepareConversationWorkspace(name, args, current) {
  const scope = requestConversationScope();
  const inferred = inferredWorkspace(name, args);
  let authorizationArgs = inferred && !args.workspaceId ? { ...args, workspaceId: inferred } : args;
  if (!scope || !workspaceScopedTool(name)) return { current, args: authorizationArgs };

  let binding = conversationWorkspace(current, scope);
  if (!binding) {
    const fallback = defaultConversationWorkspace(current);
    if (!fallback) throw new Error('No workspace configured');
    persistDefaultConversationBinding(scope, fallback);
    current = normalizeInstanceConfig(readConfig());
    binding = conversationWorkspace(current, scope);
  }
  if (!binding) throw new Error('No workspace configured');

  if (authorizationArgs.workspaceId) {
    const requested = resolveWorkspace(current, authorizationArgs.workspaceId);
    assertConversationWorkspaceMatch(current, scope, requested);
  }
  return { current, args: { ...authorizationArgs, workspaceId: binding.id } };
}

async function authorizedToolExecution(name, config, handler, args, rest) {
  let current = normalizeInstanceConfig(readConfig());
  const prepared = prepareConversationWorkspace(name, args, current);
  current = prepared.current;
  const authorizationArgs = prepared.args;
  const authorized = authorizeToolCall({
    name,
    annotations: config?.annotations || {},
    args: authorizationArgs,
    config: current,
    principal: principalNow()
  });
  const executionArgs = bindAuthorizedWorkspaceArgs(authorizationArgs, authorized);

  if (name !== 'job_cancel') {
    assertDrainAllows({ principal: authorized.principal, capability: authorized.capability, tool: name });
  }

  const leaseProtected = !name.startsWith('workspace_lease_');
  if (leaseProtected) {
    assertWorkspaceLease({
      workspaceId: authorized.workspaceId,
      principal: authorized.principal,
      capability: authorized.capability,
      config: current
    });
  }

  const started = Date.now();
  const labels = {
    tool: name,
    capability: authorized.capability,
    role: authorized.principal.role,
    source: authorized.principal.source
  };
  const active = authorized.workspaceId ? activeWorkSession(authorized.principal.id, authorized.workspaceId) : null;
  let leaseHold = null;
  const releaseLeaseHoldSafely = async stage => {
    if (!leaseHold) return;
    const hold = leaseHold;
    leaseHold = null;
    try {
      releaseWorkspaceLeaseHold({
        workspaceId: hold.workspaceId,
        holdId: hold.id,
        leaseId: hold.leaseId,
        principalId: hold.principalId
      });
    } catch (cleanupError) {
      incrementCounter('devmate_workspace_lease_hold_cleanup_total', { tool: name, stage, status: 'error' }, 1);
      await audit('workspace_lease_hold_release_failed', {
        requestId: requestContext()?.requestId || null,
        principalId: authorized.principal.id,
        tool: name,
        capability: authorized.capability,
        workspace: hold.workspaceId,
        holdId: hold.id,
        stage,
        error: String(cleanupError?.message || cleanupError).slice(0, 1000)
      }, { workSessionId: active?.id || null });
    }
  };

  try {
    if (leaseProtected) {
      leaseHold = acquireWorkspaceLeaseHold({
        workspaceId: authorized.workspaceId,
        principal: authorized.principal,
        capability: authorized.capability,
        config: current,
        purpose: name
      });
    }

    const approval = ensureToolApproval({
      config: current,
      principal: authorized.principal,
      tool: name,
      capability: authorized.capability,
      workspaceId: authorized.workspaceId,
      args: executionArgs
    });
    if (approval?.approved) incrementCounter('devmate_approvals_total', { status: 'consumed', tool: name }, 1);

    const invocationSignal = rest[0]?.mcpReq?.signal || rest[0]?.signal || requestContext()?.signal || null;
    let rawResult;
    try {
      rawResult = await runWithRequestSignal(invocationSignal, () =>
        runWithWorkSessionContext(active?.id || null, () => handler(executionArgs, ...rest))
      );
    } finally {
      await releaseLeaseHoldSafely('post-handler');
    }

    const result = filterResult(name, markGitFailure(name, rawResult), authorized.principal, authorized.workspaceId);
    const session = authorized.workspaceId
      ? touchWorkSession(authorized.principal.id, authorized.workspaceId, { failed: result?.isError === true })
      : null;
    const workSessionId = session?.id || active?.id || null;
    const toolStatus = result?.isError === true ? 'error' : 'success';
    incrementCounter('devmate_tool_calls_total', { ...labels, status: toolStatus }, 1);
    observeDuration('devmate_tool_duration_ms', labels, Date.now() - started);
    const failedPhase = result?.structuredContent?.failedPhase;
    await audit('tool_call', {
      requestId: requestContext()?.requestId || null,
      principalId: authorized.principal.id,
      principalRole: authorized.principal.role,
      tool: name,
      capability: authorized.capability,
      workspace: authorized.workspaceId,
      approvalId: approval?.request?.id || null,
      ok: result?.isError !== true,
      durationMs: Date.now() - started,
      ...(result?.isError === true ? { error: failedPhase ? `Git subprocess failed during ${failedPhase}` : 'Tool returned an MCP error result' } : {})
    }, { workSessionId });
    return result;
  } catch (error) {
    await releaseLeaseHoldSafely('error-path');
    const session = authorized.workspaceId
      ? touchWorkSession(authorized.principal.id, authorized.workspaceId, { failed: true })
      : null;
    const workSessionId = session?.id || active?.id || null;
    const status = error?.code === 'approval_required' ? 'approval_required' : 'error';
    incrementCounter('devmate_tool_calls_total', { ...labels, status }, 1);
    observeDuration('devmate_tool_duration_ms', labels, Date.now() - started);
    if (error?.code === 'approval_required') incrementCounter('devmate_approvals_total', { status: 'pending', tool: name }, 1);
    await audit('tool_call', {
      requestId: requestContext()?.requestId || null,
      principalId: authorized.principal.id,
      principalRole: authorized.principal.role,
      tool: name,
      capability: authorized.capability,
      workspace: authorized.workspaceId,
      approvalId: error?.approvalRequest?.id || null,
      ok: false,
      durationMs: Date.now() - started,
      error: String(error?.message || error).slice(0, 1000)
    }, { workSessionId });
    throw error;
  }
}

export function wrapAuthorizedTool(name, config, handler) {
  return async function authorizedToolHandler(args = {}, ...rest) {
    const conversationScope = conversationScopeFromToolContext(rest[0]);
    return runWithConversationScope(conversationScope, () => authorizedToolExecution(name, config, handler, args, rest));
  };
}

export function installTeamCapabilities(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.authorization',
    order: 10,
    decorate({ name, config, handler }) {
      const wrapped = wrapAuthorizedTool(name, config, handler);
      registerJobTarget(name, config, wrapped);
      return { handler: wrapped };
    }
  });
  registerServerInitializer(McpServerClass, {
    id: 'devmate.collaboration-tools',
    order: 10,
    initialize: registerTeamTools
  });
}

export async function shutdownTeamServices() {
  clearPreviewShares();
}

export const __test = {
  bindAuthorizedWorkspaceArgs,
  cleanOrigin,
  commandResultFailed,
  defaultConversationWorkspace,
  failedGitPhase,
  filterResult,
  inferredWorkspace,
  markGitFailure,
  persistDefaultConversationBinding,
  prepareConversationWorkspace,
  publicDeployment,
  redactCommandResultPayload,
  redactProcessOutputEvents,
  readiness,
  registerTeamTools,
  sanitizeResultPayload,
  sanitizeToolResult,
  syncTextContent,
  workspaceIds,
  wrapAuthorizedTool
};
