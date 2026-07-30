import { z } from 'zod';
import { audit, readConfig, toolText, writeConfig } from './local-shared.mjs';
import { activitySnapshot } from './request-guard.mjs';
import {
  TEAM_ROLES,
  createTeamMember,
  memberPublic,
  normalizeDeploymentConfig,
  revokeTeamMember,
  rotateTeamMemberToken,
  updateTeamMember
} from './team-access.mjs';
import {
  cleanOrigin,
  policyTemplate,
  principalNow,
  publicDeployment,
  readiness,
  teamStatus,
  workspaceIds
} from './team-tool-data.mjs';

export function registerTeamManagementTools(register, annotations) {
  const { ro, rw } = annotations;

  register('deployment_status', {
    title: 'DevMate deployment status',
    description: 'Show deployment mode, current principal, ingress metadata, and production limits.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText(publicDeployment(readConfig())));

  register('deployment_readiness', {
    title: 'DevMate deployment readiness',
    description: 'Check personal, team, or production deployment readiness.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText(readiness(readConfig())));

  register('deployment_policy_template', {
    title: 'Tunnel policy template',
    description: 'Return production-oriented ngrok or Cloudflare ingress templates without secrets.',
    inputSchema: { provider: z.enum(['ngrok', 'cloudflare-managed']).optional() },
    annotations: ro
  }, async ({ provider }) => toolText(provider
    ? policyTemplate(provider)
    : {
        ngrok: policyTemplate('ngrok'),
        cloudflare: policyTemplate('cloudflare-managed')
      }));

  register('team_status', {
    title: 'DevMate team status',
    description: 'Show current team principal, members, leases, sessions, and readiness.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText(teamStatus()));

  register('team_configure', {
    title: 'Configure DevMate team deployment',
    description: 'Configure deployment mode, tunnel metadata, lease policy, and production limits. Requires owner.',
    inputSchema: {
      mode: z.enum(['personal', 'team', 'production']).optional(),
      tunnelProvider: z.enum(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']).optional(),
      publicUrl: z.string().max(2000).optional(),
      requireWorkspaceLeaseForWrites: z.boolean().optional(),
      requestsPerMinute: z.number().int().min(10).max(10000).optional(),
      maxConcurrentRequests: z.number().int().min(1).max(256).optional(),
      maxConcurrentPerPrincipal: z.number().int().min(1).max(64).optional(),
      maxRequestBytes: z.number().int().min(65536).max(33554432).optional(),
      requestTimeoutMs: z.number().int().min(1000).max(3600000).optional(),
      allowedHosts: z.array(z.string().max(300)).max(100).optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async patch => {
    const config = normalizeDeploymentConfig(readConfig());
    if (patch.mode) config.deployment.mode = patch.mode;
    if (patch.tunnelProvider) config.deployment.tunnelProvider = patch.tunnelProvider;
    if (config.deployment.mode === 'production' && config.deployment.tunnelProvider === 'cloudflare-quick') {
      throw new Error('Cloudflare Quick Tunnel cannot be used in production mode');
    }
    if (patch.publicUrl !== undefined) {
      config.deployment.publicUrl = cleanOrigin(patch.publicUrl, config.deployment.mode === 'production');
    }
    if (patch.requireWorkspaceLeaseForWrites !== undefined) {
      config.team.requireWorkspaceLeaseForWrites = patch.requireWorkspaceLeaseForWrites;
    }
    for (const key of [
      'requestsPerMinute',
      'maxConcurrentRequests',
      'maxConcurrentPerPrincipal',
      'maxRequestBytes',
      'requestTimeoutMs'
    ]) {
      if (patch[key] !== undefined) config.production[key] = patch[key];
    }
    if (patch.allowedHosts !== undefined) config.production.allowedHosts = patch.allowedHosts;
    normalizeDeploymentConfig(config);
    writeConfig(config);
    await audit('team_configure', {
      principalId: principalNow().id,
      mode: config.deployment.mode,
      tunnelProvider: config.deployment.tunnelProvider
    });
    return toolText({ configured: true, deployment: publicDeployment(config), readiness: readiness(config) });
  });

  register('team_member_list', {
    title: 'List DevMate team members',
    description: 'List team identities, roles, scopes, expiry, and token versions without exposing token hashes.',
    inputSchema: {},
    annotations: ro
  }, async () => {
    const config = normalizeDeploymentConfig(readConfig());
    return toolText({ members: config.team.members.map(memberPublic) });
  });

  register('team_member_create', {
    title: 'Create DevMate team member',
    description: 'Create a scoped team identity and return its token once. Requires owner.',
    inputSchema: {
      id: z.string().max(120).optional(),
      name: z.string().min(1).max(200),
      role: z.enum(TEAM_ROLES).optional(),
      workspaceIds: z.array(z.string().min(1).max(300)).max(100).optional(),
      expiresAt: z.string().datetime().optional()
    },
    annotations: rw
  }, async input => {
    const config = normalizeDeploymentConfig(readConfig());
    const result = createTeamMember(config, {
      ...input,
      workspaceIds: workspaceIds(config, input.workspaceIds || [])
    });
    writeConfig(config);
    await audit('team_member_create', {
      principalId: principalNow().id,
      memberId: result.member.id,
      role: result.member.role,
      workspaceIds: result.member.workspaceIds
    });
    return toolText({
      ...result,
      warning: 'The token is shown once. Store it in an approved secret manager and do not commit it.'
    });
  });

  register('team_member_update', {
    title: 'Update DevMate team member',
    description: 'Update role, workspace scopes, expiry, or enabled state. Requires owner.',
    inputSchema: {
      id: z.string().min(1),
      name: z.string().max(200).optional(),
      role: z.enum(TEAM_ROLES).optional(),
      workspaceIds: z.array(z.string().min(1).max(300)).max(100).optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      disabled: z.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, ...patch }) => {
    const config = normalizeDeploymentConfig(readConfig());
    if (patch.workspaceIds !== undefined) patch.workspaceIds = workspaceIds(config, patch.workspaceIds);
    const member = updateTeamMember(config, id, patch);
    writeConfig(config);
    await audit('team_member_update', {
      principalId: principalNow().id,
      memberId: id,
      keys: Object.keys(patch)
    });
    return toolText({ member });
  });

  register('team_member_rotate', {
    title: 'Rotate DevMate team token',
    description: 'Invalidate the old team token and return a new token once. Requires owner.',
    inputSchema: { id: z.string().min(1) },
    annotations: rw
  }, async ({ id }) => {
    const config = normalizeDeploymentConfig(readConfig());
    const result = rotateTeamMemberToken(config, id);
    writeConfig(config);
    await audit('team_member_rotate', { principalId: principalNow().id, memberId: id });
    return toolText({
      ...result,
      warning: 'The replacement token is shown once. Update the team secret and revoke old copies.'
    });
  });

  register('team_member_revoke', {
    title: 'Revoke DevMate team member',
    description: 'Disable a team identity immediately. Requires owner.',
    inputSchema: { id: z.string().min(1) },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const config = normalizeDeploymentConfig(readConfig());
    const member = revokeTeamMember(config, id);
    writeConfig(config);
    await audit('team_member_revoke', { principalId: principalNow().id, memberId: id });
    return toolText({ member });
  });

  register('team_activity_status', {
    title: 'DevMate team activity',
    description: 'Show recent authenticated MCP clients, request counts, roles, and session IDs. Requires maintainer or owner.',
    inputSchema: { activeWithinMinutes: z.number().int().min(1).max(1440).optional() },
    annotations: ro
  }, async ({ activeWithinMinutes = 60 }) => toolText({
    activities: activitySnapshot({ activeWithinMinutes })
  }));
}
