import { z } from 'zod';
import { audit, readConfig } from './local-shared.mjs';
import { requestContext } from './request-context.mjs';
import { authorizeToolCall, normalizeDeploymentConfig } from './team-access.mjs';
import { listPersistentProcesses } from './persistent-processes.mjs';
import { getPreview } from './plugins/preview-manager.mjs';
import {
  activeWorkSession,
  clearWorkSessions,
  touchWorkSession
} from './team-work-sessions.mjs';
import {
  assertWorkspaceLease,
  clearWorkspaceLeases
} from './workspace-leases.mjs';
import { clearPreviewShares } from './published-previews.mjs';
import { registerTeamManagementTools } from './team-management-tools.mjs';
import { registerTeamCollaborationTools } from './team-collaboration-tools.mjs';
import {
  cleanOrigin,
  principalNow,
  publicDeployment,
  readiness,
  workspaceIds
} from './team-tool-data.mjs';

const INSTALLED = Symbol.for('devmate.teamCapabilitiesInstalled');
const REGISTERED = Symbol.for('devmate.teamToolsRegistered');
const AUTH_WRAPPED = Symbol.for('devmate.teamToolAuthorizationWrapped');

function registerTeamTools(server) {
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

function installAuthorizationWrapper(McpServerClass) {
  if (McpServerClass.prototype[AUTH_WRAPPED]) return;
  const originalRegisterTool = McpServerClass.prototype.registerTool;
  Object.defineProperty(McpServerClass.prototype, AUTH_WRAPPED, { value: true });

  McpServerClass.prototype.registerTool = function authorizedRegisterTool(name, config, handler) {
    return originalRegisterTool.call(this, name, config, async (args = {}, ...rest) => {
      const current = normalizeDeploymentConfig(readConfig());
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

      if (!name.startsWith('workspace_lease_')) {
        assertWorkspaceLease({
          workspaceId: authorized.workspaceId,
          principal: authorized.principal,
          capability: authorized.capability,
          config: current
        });
      }

      const started = Date.now();
      const active = authorized.workspaceId
        ? activeWorkSession(authorized.principal.id, authorized.workspaceId)
        : null;
      try {
        const result = filterResult(name, await handler(args, ...rest), authorized.principal);
        const session = authorized.workspaceId
          ? touchWorkSession(authorized.principal.id, authorized.workspaceId)
          : null;
        await audit('team_tool_call', {
          requestId: requestContext()?.requestId || null,
          principalId: authorized.principal.id,
          principalRole: authorized.principal.role,
          tool: name,
          capability: authorized.capability,
          workspace: authorized.workspaceId,
          workSessionId: session?.id || active?.id || null,
          ok: true,
          durationMs: Date.now() - started
        });
        return result;
      } catch (error) {
        const session = authorized.workspaceId
          ? touchWorkSession(authorized.principal.id, authorized.workspaceId, { failed: true })
          : null;
        await audit('team_tool_call', {
          requestId: requestContext()?.requestId || null,
          principalId: authorized.principal.id,
          principalRole: authorized.principal.role,
          tool: name,
          capability: authorized.capability,
          workspace: authorized.workspaceId,
          workSessionId: session?.id || active?.id || null,
          ok: false,
          durationMs: Date.now() - started,
          error: String(error?.message || error).slice(0, 1000)
        });
        throw error;
      }
    });
  };
}

export function installTeamCapabilities(McpServerClass) {
  installAuthorizationWrapper(McpServerClass);
  if (McpServerClass.prototype[INSTALLED]) return;
  const originalConnect = McpServerClass.prototype.connect;
  Object.defineProperty(McpServerClass.prototype, INSTALLED, { value: true });
  McpServerClass.prototype.connect = async function teamCapabilitiesConnect(...args) {
    registerTeamTools(this);
    return originalConnect.apply(this, args);
  };
}

export async function shutdownTeamServices() {
  clearPreviewShares();
  clearWorkSessions();
  clearWorkspaceLeases();
}

export const __test = {
  cleanOrigin,
  filterResult,
  inferredWorkspace,
  publicDeployment,
  readiness,
  registerTeamTools,
  syncTextContent,
  workspaceIds
};
