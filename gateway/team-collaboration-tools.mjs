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
  startWorkSession
} from './team-work-sessions.mjs';
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

  register('team_work_session_start', {
    title: 'Start team work session',
    description: 'Start a principal-scoped complex work session and acquire its workspace lease.',
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
    await audit('team_work_session_start', {
      principalId: principal.id,
      workspace: workspace.id,
      sessionId: session.id,
      leaseId: session.leaseId
    });
    return toolText({ session });
  });

  register('team_work_session_status', {
    title: 'Team work session status',
    description: 'List the caller work sessions or, for maintainers and owners, visible team sessions.',
    inputSchema: {
      workspaceId: z.string().optional(),
      all: z.boolean().optional()
    },
    annotations: ro
  }, async ({ workspaceId, all = false }) => {
    const principal = principalNow();
    const config = normalizeDeploymentConfig(readConfig());
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

  register('team_work_session_finish', {
    title: 'Finish team work session',
    description: 'Finish a work session and optionally release its lease.',
    inputSchema: {
      id: z.string().min(1),
      force: z.boolean().optional(),
      releaseLease: z.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, force = false, releaseLease = true }) => {
    const principal = principalNow();
    const result = finishWorkSession({ id, principal, force, releaseLease });
    await audit('team_work_session_finish', {
      principalId: principal.id,
      sessionId: id,
      finished: result.finished
    });
    return toolText(result);
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
