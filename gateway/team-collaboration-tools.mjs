import { z } from 'zod';
import { audit, mutateConfig, permissionProfile, readConfig, toolText } from './local-shared.mjs';
import {
  assertConversationWorkspaceMatch,
  bindConversationWorkspaceToPath,
  bindConversationWorkspaceToWorkspace,
  clearConversationWorkspaceBinding,
  conversationWorkspace,
  publicConversationWorkspaceBinding
} from './conversation-workspaces.mjs';
import { requestConversationScope } from './request-context.mjs';
import { normalizeInstanceConfig } from './team-access.mjs';
import { getPreview } from './plugins/preview-manager.mjs';
import {
  createPreviewShare,
  listPreviewShares,
  revokePreviewShare
} from './published-previews.mjs';
import {
  finishWorkSession,
  listWorkSessions,
  startWorkSession,
  workSession
} from './work-sessions.mjs';
import { rollbackWorkSession } from './work-session-rollback.mjs';
import {
  acquireWorkspaceLease,
  listWorkspaceLeases,
  releaseWorkspaceLease,
  workspaceLease
} from './workspace-leases.mjs';
import { principalNow } from './team-tool-data.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

function assertVisibleWorkspace(principal, workspaceId, action = 'access') {
  if (principal.workspaceIds?.length && !principal.workspaceIds.includes(workspaceId)) {
    throw new Error(`Principal ${principal.id} is not allowed to ${action} workspace ${workspaceId}`);
  }
}

function assertConversationScope() {
  const scope = requestConversationScope();
  if (scope) return scope;
  const error = new Error('ChatGPT conversation metadata is unavailable. Conversation workspace binding cannot be used safely; pass an explicit workspaceId on every project tool call.');
  error.code = 'conversation_scope_unavailable';
  throw error;
}

function defaultConversationWorkspace(config) {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  return workspaces.find(item => item?.id === config?.activeWorkspaceId && !item.reference && item.mode !== 'readonly')
    || workspaces.find(item => item && !item.reference && item.mode !== 'readonly')
    || workspaces[0]
    || null;
}

function selectedConversationProject(requested = '') {
  const scope = requestConversationScope();
  let config = normalizeInstanceConfig(readConfig());
  if (!scope) return { config, scope: null, workspace: null };

  let workspace = conversationWorkspace(config, scope);
  if (!workspace) {
    const fallback = defaultConversationWorkspace(config);
    if (!fallback) throw new Error('No workspace configured');
    mutateConfig(current => {
      normalizeInstanceConfig(current);
      if (!conversationWorkspace(current, scope)) {
        bindConversationWorkspaceToWorkspace(current, scope, fallback, { source: 'default' });
      }
      return current;
    }, { retries: 4 });
    config = normalizeInstanceConfig(readConfig());
    workspace = conversationWorkspace(config, scope);
  }

  if (!workspace) throw new Error('No workspace configured');
  if (requested) {
    const candidate = resolveWorkspace(config, requested);
    assertConversationWorkspaceMatch(config, scope, candidate);
  }
  return { config, scope, workspace };
}

function bindWorkspace(input) {
  const scope = assertConversationScope();
  let result = null;
  mutateConfig(config => {
    normalizeInstanceConfig(config);
    if (input.path) {
      result = bindConversationWorkspaceToPath(config, scope, input.path, {
        source: 'explicit-path',
        allowExternalWrite: permissionProfile(config) === 'fullAccess'
      });
    } else {
      const workspace = resolveWorkspace(config, input.workspaceId);
      result = bindConversationWorkspaceToWorkspace(config, scope, workspace, { source: 'explicit-workspace' });
    }
    return config;
  }, { retries: 4 });
  return result;
}

export function registerTeamCollaborationTools(register, annotations) {
  const { ro, rw } = annotations;

  register('workspace_binding_status', {
    title: 'Conversation workspace binding',
    description: 'Show the project selected for this ChatGPT conversation.',
    inputSchema: {},
    annotations: ro
  }, async () => {
    const config = normalizeInstanceConfig(readConfig());
    return toolText({
      conversationScoped: !!requestConversationScope(),
      binding: publicConversationWorkspaceBinding(config),
      rule: 'An explicit absolute local path takes precedence. Without one, DevMate uses the current default workspace.'
    });
  });

  register('workspace_bind', {
    title: 'Bind this conversation to a workspace',
    description: 'Use path when the user provides an absolute local project/file path. Use workspaceId only when the user explicitly selects a configured workspace.',
    inputSchema: {
      path: z.string().min(1).optional(),
      workspaceId: z.string().min(1).optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async input => {
    const hasPath = !!String(input.path || '').trim();
    const hasWorkspace = !!String(input.workspaceId || '').trim();
    if (hasPath === hasWorkspace) throw new Error('workspace_bind requires exactly one of path or workspaceId');
    const binding = bindWorkspace(input);
    await audit('workspace_bind', {
      workspace: binding.workspaceId,
      root: binding.root,
      source: binding.source,
      conversationScope: requestConversationScope()
    });
    return toolText({
      bound: true,
      binding: {
        workspaceId: binding.workspaceId,
        name: binding.name,
        root: binding.root,
        mode: binding.mode,
        source: binding.source
      }
    });
  });

  register('workspace_unbind', {
    title: 'Unbind this conversation workspace',
    description: 'Remove this ChatGPT conversation project selection.',
    inputSchema: {},
    annotations: { ...rw, idempotentHint: true }
  }, async () => {
    const scope = assertConversationScope();
    let removed = false;
    mutateConfig(config => {
      normalizeInstanceConfig(config);
      removed = clearConversationWorkspaceBinding(config, scope);
      return config;
    }, { retries: 4 });
    await audit('workspace_unbind', { removed, conversationScope: scope });
    return toolText({ removed });
  });

  register('work_session_start', {
    title: 'Start work session',
    description: 'Start a principal-scoped work session and acquire its workspace lease. The same session model is used for owner and member workflows.',
    inputSchema: {
      workspaceId: z.string().min(1).optional(),
      title: z.string().max(500).optional(),
      purpose: z.string().max(1000).optional(),
      ttlSeconds: z.number().int().min(300).max(86400).optional(),
      force: z.boolean().optional()
    },
    annotations: rw
  }, async input => {
    const selected = selectedConversationProject(input.workspaceId);
    const config = selected.config;
    const principal = principalNow();
    const workspace = selected.scope ? selected.workspace : resolveWorkspace(config, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, 'start a session for');
    const session = startWorkSession({
      ...input,
      workspaceId: workspace.id,
      principal
    });
    await audit('work_session_start', {
      principalId: principal.id,
      principalName: principal.name,
      workspace: workspace.id,
      leaseId: session.leaseId,
      title: session.title,
      purpose: session.purpose
    }, { workSessionId: session.id });
    return toolText({ session });
  });

  register('work_session_status', {
    title: 'Work session status',
    description: 'Inspect one visible work session or list the caller sessions. Maintainers and owners may list all visible sessions.',
    inputSchema: {
      id: z.string().optional(),
      workspaceId: z.string().optional(),
      all: z.boolean().optional()
    },
    annotations: ro
  }, async ({ id, workspaceId, all = false }) => {
    const principal = principalNow();
    const selected = selectedConversationProject(workspaceId);
    const config = selected.config;
    if (id) {
      const item = workSession(id);
      if (!item) return toolText({ session: null });
      if (selected.scope && item.workspaceId !== selected.workspace.id) {
        throw new Error(`Work session ${id} belongs to a different project workspace`);
      }
      assertVisibleWorkspace(principal, item.workspaceId);
      const canSeeOthers = ['owner', 'maintainer'].includes(principal.role);
      if (item.principalId !== principal.id && !canSeeOthers) {
        throw new Error(`Work session ${id} belongs to ${item.principalName || item.principalId}`);
      }
      return toolText({ session: item });
    }
    const resolvedWorkspaceId = selected.scope ? selected.workspace.id : (workspaceId ? resolveWorkspace(config, workspaceId).id : undefined);
    if (resolvedWorkspaceId) assertVisibleWorkspace(principal, resolvedWorkspaceId);
    const canSeeAll = ['owner', 'maintainer'].includes(principal.role);
    let items = listWorkSessions({
      principalId: all && canSeeAll ? undefined : principal.id,
      workspaceId: resolvedWorkspaceId
    });
    if (principal.workspaceIds?.length) {
      items = items.filter(item => principal.workspaceIds.includes(item.workspaceId));
    }
    return toolText({ sessions: items });
  });

  register('work_session_finish', {
    title: 'Finish work session',
    description: 'Finish a work session and optionally release the lease that belongs to that session tenure.',
    inputSchema: {
      id: z.string().min(1),
      force: z.boolean().optional(),
      releaseLease: z.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, force = false, releaseLease = true }) => {
    const principal = principalNow();
    const selected = selectedConversationProject();
    const item = workSession(id);
    if (selected.scope && item && item.workspaceId !== selected.workspace.id) {
      throw new Error(`Work session ${id} belongs to a different project workspace`);
    }
    const result = finishWorkSession({ id, principal, force, releaseLease });
    await audit('work_session_finish', {
      principalId: principal.id,
      workspace: result.session?.workspaceId || null,
      finished: result.finished,
      leaseReleased: result.lease?.released === true
    }, { workSessionId: id });
    return toolText(result);
  });

  register('work_session_rollback', {
    title: 'Rollback work session',
    description: 'Rollback safe file mutations recorded in a work session. Non-owner callers must hold the affected workspace lease; commands and Git history are never automatically reversed. Maintainers and owners must pass force=true to rollback another principal session.',
    inputSchema: {
      workSessionId: z.string().min(1),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional()
    },
    annotations: rw
  }, async ({ workSessionId, dryRun = false, force = false, limit = 1000 }) => {
    const principal = principalNow();
    const selected = selectedConversationProject();
    const item = workSession(workSessionId);
    if (selected.scope && item && item.workspaceId !== selected.workspace.id) {
      throw new Error(`Work session ${workSessionId} belongs to a different project workspace`);
    }
    return toolText(await rollbackWorkSession({ workSessionId, principal, dryRun, force, limit }));
  });

  register('published_preview_share', {
    title: 'Publish team preview',
    description: 'Create a scoped, time-limited public review URL. Requires maintainer or owner.',
    inputSchema: {
      previewId: z.string().min(1),
      ttlSeconds: z.number().int().min(60).max(86400).optional(),
      maxUses: z.number().int().min(0).max(100000).optional()
    },
    annotations: { ...rw, openWorldHint: true }
  }, async input => {
    const selected = selectedConversationProject();
    const config = selected.config;
    const principal = principalNow();
    const preview = getPreview(input.previewId);
    if (selected.scope && preview.workspaceId !== selected.workspace.id) {
      throw new Error(`Preview ${input.previewId} belongs to a different project workspace`);
    }
    assertVisibleWorkspace(principal, preview.workspaceId, 'publish');
    const result = createPreviewShare({
      ...input,
      principal,
      publicUrl: config.connection.publicUrl
    });
    await audit('published_preview_share', {
      principalId: principal.id,
      shareId: result.share.id,
      previewId: input.previewId,
      workspace: result.share.workspaceId
    });
    return toolText({
      ...result,
      warning: 'Share only with intended reviewers and revoke after review.'
    });
  });

  register('published_preview_list', {
    title: 'List published previews',
    description: 'List active preview shares. Requires maintainer or owner.',
    inputSchema: {
      workspaceId: z.string().optional(),
      previewId: z.string().optional()
    },
    annotations: ro
  }, async filters => {
    const principal = principalNow();
    const selected = selectedConversationProject(filters.workspaceId);
    const effectiveFilters = selected.scope ? { ...filters, workspaceId: selected.workspace.id } : filters;
    let items = listPreviewShares(effectiveFilters);
    if (principal.workspaceIds?.length) {
      items = items.filter(item => principal.workspaceIds.includes(item.workspaceId));
    }
    return toolText({ shares: items });
  });

  register('published_preview_revoke', {
    title: 'Revoke published preview',
    description: 'Revoke a preview share. Requires maintainer or owner.',
    inputSchema: { id: z.string().min(1) },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const principal = principalNow();
    const selected = selectedConversationProject();
    const item = listPreviewShares().find(value => value.id === id);
    if (selected.scope && item && item.workspaceId !== selected.workspace.id) {
      throw new Error(`Published preview ${id} belongs to a different project workspace`);
    }
    if (item) assertVisibleWorkspace(principal, item.workspaceId, 'revoke a share for');
    const result = revokePreviewShare(id);
    await audit('published_preview_revoke', {
      principalId: principal.id,
      shareId: id
    });
    return toolText(result);
  });

  register('workspace_lease_acquire', {
    title: 'Acquire workspace lease',
    description: 'Acquire or renew an exclusive workspace lease.',
    inputSchema: {
      workspaceId: z.string().min(1),
      ttlSeconds: z.number().int().min(60).max(86400).optional(),
      purpose: z.string().max(500).optional(),
      force: z.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async input => {
    const config = normalizeInstanceConfig(readConfig());
    const principal = principalNow();
    const workspace = resolveWorkspace(config, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, 'lease');
    const lease = acquireWorkspaceLease({
      ...input,
      workspaceId: workspace.id,
      principal
    });
    await audit('workspace_lease_acquire', {
      principalId: principal.id,
      workspace: workspace.id,
      leaseId: lease.id
    });
    return toolText({ lease });
  });

  register('workspace_lease_status', {
    title: 'Workspace lease status',
    description: 'List visible leases or inspect one workspace.',
    inputSchema: { workspaceId: z.string().optional() },
    annotations: ro
  }, async ({ workspaceId }) => {
    const principal = principalNow();
    const selected = selectedConversationProject(workspaceId);
    const config = selected.config;
    const resolvedWorkspaceId = selected.scope ? selected.workspace.id : (workspaceId ? resolveWorkspace(config, workspaceId).id : undefined);
    if (resolvedWorkspaceId) assertVisibleWorkspace(principal, resolvedWorkspaceId);
    let leases = resolvedWorkspaceId
      ? [workspaceLease(resolvedWorkspaceId)].filter(Boolean)
      : listWorkspaceLeases();
    if (principal.workspaceIds?.length) {
      leases = leases.filter(item => principal.workspaceIds.includes(item.workspaceId));
    }
    return toolText(resolvedWorkspaceId ? { lease: leases[0] || null } : { leases });
  });

  register('workspace_lease_release', {
    title: 'Release workspace lease',
    description: 'Release an owned lease; maintainers and owners may force release.',
    inputSchema: {
      workspaceId: z.string().min(1),
      force: z.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async input => {
    const config = normalizeInstanceConfig(readConfig());
    const principal = principalNow();
    const workspace = resolveWorkspace(config, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, 'release a lease for');
    const result = releaseWorkspaceLease({ ...input, workspaceId: workspace.id, principal });
    await audit('workspace_lease_release', {
      principalId: principal.id,
      workspace: workspace.id
    });
    return toolText(result);
  });
}
