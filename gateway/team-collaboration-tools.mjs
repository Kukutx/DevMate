import { z } from 'zod';
import { audit, readConfig, toolText } from './local-shared.mjs';
import { normalizeDeploymentConfig } from './team-access.mjs';
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
import { resolveWorkspaceId } from './workspace-resolver.mjs';

function resolveWorkspace(config, value) {
  const id = resolveWorkspaceId(config, String(value || '').trim());
  const workspace = config.workspaces?.find(item => item.id === id);
  if (!workspace) throw new Error(`Workspace not found: ${value}`);
  return workspace;
}

function assertVisibleWorkspace(principal, workspaceId, action = 'access') {
  if (principal.workspaceIds?.length && !principal.workspaceIds.includes(workspaceId)) {
    throw new Error(`Principal ${principal.id} is not allowed to ${action} workspace ${workspaceId}`);
  }
}

export function registerTeamCollaborationTools(register, annotations) {
  const { ro, rw } = annotations;

  register('work_session_start', {
    title: 'Start work session',
    description: 'Start a principal-scoped work session and acquire its workspace lease. Available in personal, team, and production modes.',
    inputSchema: {
      workspaceId: z.string().min(1),
      title: z.string().max(500).optional(),
      purpose: z.string().max(1000).optional(),
      ttlSeconds: z.number().int().min(300).max(86400).optional(),
      force: z.boolean().optional()
    },
    annotations: rw
  }, async input => {
    const config = normalizeDeploymentConfig(readConfig());
    const principal = principalNow();
    const workspace = resolveWorkspace(config, input.workspaceId);
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
    const config = normalizeDeploymentConfig(readConfig());
    if (id) {
      const item = workSession(id);
      if (!item) return toolText({ session: null });
      assertVisibleWorkspace(principal, item.workspaceId);
      const canSeeOthers = ['owner', 'maintainer'].includes(principal.role);
      if (item.principalId !== principal.id && !canSeeOthers) {
        throw new Error(`Work session ${id} belongs to ${item.principalName || item.principalId}`);
      }
      return toolText({ session: item });
    }
    const resolvedWorkspaceId = workspaceId ? resolveWorkspace(config, workspaceId).id : undefined;
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
    description: 'Rollback safe file mutations recorded in a work session. Team callers must hold the affected workspace lease; commands and Git history are never automatically reversed. Maintainers and owners must pass force=true to rollback another principal session.',
    inputSchema: {
      workSessionId: z.string().min(1),
      dryRun: z.boolean().optional(),
      force: z.boolean().optional(),
      limit: z.number().int().min(1).max(1000).optional()
    },
    annotations: rw
  }, async ({ workSessionId, dryRun = false, force = false, limit = 1000 }) => {
    const principal = principalNow();
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
    const config = normalizeDeploymentConfig(readConfig());
    const principal = principalNow();
    const preview = getPreview(input.previewId);
    assertVisibleWorkspace(principal, preview.workspaceId, 'publish');
    const result = createPreviewShare({
      ...input,
      principal,
      publicUrl: config.deployment.publicUrl
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
    let items = listPreviewShares(filters);
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
    const item = listPreviewShares().find(value => value.id === id);
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
    const config = normalizeDeploymentConfig(readConfig());
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
    const config = normalizeDeploymentConfig(readConfig());
    const resolvedWorkspaceId = workspaceId ? resolveWorkspace(config, workspaceId).id : undefined;
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
    const config = normalizeDeploymentConfig(readConfig());
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
