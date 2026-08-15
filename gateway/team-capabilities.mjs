import { z } from 'zod';
import { audit, readConfig } from './local-shared.mjs';
import { requestContext, runWithRequestSignal, runWithWorkSessionContext } from './request-context.mjs';
import { authorizeToolCall, normalizeInstanceConfig } from './team-access.mjs';
import { listPersistentProcesses } from './persistent-processes.mjs';
import { getPreview } from './plugins/preview-manager.mjs';
import { activeWorkSession, touchWorkSession } from './work-sessions.mjs';
import { assertWorkspaceLease } from './workspace-leases.mjs';
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
    ro: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    rw: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  };
  registerTeamManagementTools(register, annotations);
  registerTeamCollaborationTools(register, annotations);
  registerApprovalTools(register, annotations);
  registerJobTools(register, annotations);
}

function inferredWorkspace(name, args = {}) {
  if (
    ['process_status', 'read_process_output', 'send_process_input', 'stop_process'].includes(name) &&
    args.id
  ) {
    return listPersistentProcesses(true).find(item => item.id === args.id)?.workspaceId || null;
  }
  if (['web_preview_status', 'web_preview_stop'].includes(name) && args.id) {
    try {
      return getPreview(args.id)?.workspaceId || null;
    } catch {
      return null;
    }
  }
  return null;
}

function filterArray(items, allowed, field = 'workspaceId') {
  return Array.isArray(items) ? items.filter(item => allowed.has(item?.[field] || item?.id)) : items;
}

function syncTextContent(result) {
  if (!Array.isArray(result?.content) || !result?.structuredContent) return result;
  const json = JSON.stringify(result.structuredContent, null, 2);
  for (const item of result.content) {
    if (item?.type === 'text') item.text = json;
  }
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
    for (const phase of ['stage', 'commit', 'push', 'status']) {
      if (commandResultFailed(data[phase])) return phase;
    }
    return '';
  }
  if (tool === 'git_commit') {
    for (const phase of ['stage', 'commit', 'status']) {
      if (commandResultFailed(data[phase])) return phase;
    }
    return '';
  }
  if (tool === 'git_add' || tool === 'git_stage') {
    for (const phase of ['stage', 'status']) {
      if (commandResultFailed(data[phase])) return phase;
    }
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

function filterResult(name, result, principal) {
  if (!principal?.workspaceIds?.length || !result?.structuredContent) return result;
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
    data.running = Array.isArray(data.processes)
      ? data.processes.filter(item => ['running', 'stopping'].includes(item.status)).length
      : 0;
  }
  if (name === 'web_preview_status') {
    data.previews = filterArray(data.previews, allowed);
    if (data.preview && !allowed.has(data.preview.workspaceId)) data.preview = null;
  }
  if (name === 'local_capabilities_status') {
    data.trustedWritableRoots = filterArray(data.trustedWritableRoots, allowed, 'id');
    data.persistentProcesses = filterArray(data.persistentProcesses, allowed);
  }
  if (name === 'list_trusted_roots') {
    data.roots = filterArray(data.roots, allowed, 'id');
  }
  return syncTextContent(result);
}

export function wrapAuthorizedTool(name, config, handler) {
  return async function authorizedToolHandler(args = {}, ...rest) {
    const current = normalizeInstanceConfig(readConfig());
    const inferred = inferredWorkspace(name, args);
    const authorizationArgs = inferred && !args.workspaceId
      ? { ...args, workspaceId: inferred }
      : args;
    const authorized = authorizeToolCall({
      name,
      annotations: config?.annotations || {},
      args: authorizationArgs,
      config: current,
      principal: principalNow()
    });

    if (name !== 'job_cancel') {
      assertDrainAllows({
        principal: authorized.principal,
        capability: authorized.capability,
        tool: name
      });
    }

    if (!name.startsWith('workspace_lease_')) {
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
    const active = authorized.workspaceId
      ? activeWorkSession(authorized.principal.id, authorized.workspaceId)
      : null;
    try {
      const approval = ensureToolApproval({
        config: current,
        principal: authorized.principal,
        tool: name,
        capability: authorized.capability,
        workspaceId: authorized.workspaceId,
        args: authorizationArgs
      });
      if (approval?.approved) incrementCounter('devmate_approvals_total', { status: 'consumed', tool: name }, 1);

      const invocationSignal = rest[0]?.signal || requestContext()?.signal || null;
      const rawResult = await runWithRequestSignal(invocationSignal, () =>
        runWithWorkSessionContext(active?.id || null, () => handler(args, ...rest))
      );
      const result = filterResult(
        name,
        markGitFailure(name, rawResult),
        authorized.principal
      );
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
  cleanOrigin,
  commandResultFailed,
  failedGitPhase,
  filterResult,
  inferredWorkspace,
  markGitFailure,
  publicDeployment,
  readiness,
  registerTeamTools,
  syncTextContent,
  workspaceIds,
  wrapAuthorizedTool
};
