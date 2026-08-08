import { z } from 'zod';
import deploymentHosts from '../shared/deployment-hosts.cjs';
import { audit, readConfig, toolText, writeConfig } from './local-shared.mjs';
import { activitySnapshot } from './request-guard.mjs';
import {
  TEAM_ROLES,
  TUNNEL_PROVIDERS,
  createTeamMember,
  memberPublic,
  normalizeInstanceConfig,
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

const { normalizeAllowedHosts } = deploymentHosts;

export function applyTeamConfigurationPatch(inputConfig, patch = {}) {
  const config = normalizeInstanceConfig(inputConfig);
  const previousProvider = config.connection.provider;
  if (patch.tunnelProvider) config.connection.provider = patch.tunnelProvider;

  const providerChanged = patch.tunnelProvider !== undefined && patch.tunnelProvider !== previousProvider;
  if (patch.publicUrl !== undefined) {
    config.connection.publicUrl = cleanOrigin(patch.publicUrl, false);
  } else if (providerChanged || config.connection.provider === 'cloudflare-quick') {
    config.connection.publicUrl = '';
  }

  const connectionTouched = patch.tunnelProvider !== undefined || patch.publicUrl !== undefined;
  if (
    connectionTouched &&
    (config.connection.provider === 'cloudflare-managed' || config.connection.provider === 'external') &&
    !config.connection.publicUrl
  ) {
    throw new Error(`${config.connection.provider} requires a public HTTPS URL`);
  }

  if (patch.allowedHosts !== undefined) {
    config.requestPolicy.allowedHosts = normalizeAllowedHosts(patch.allowedHosts);
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
    if (patch[key] !== undefined) config.requestPolicy[key] = patch[key];
  }
  normalizeInstanceConfig(config);
  return config;
}

export function registerTeamManagementTools(register, annotations) {
  const { ro, rw } = annotations;

  register('deployment_status', {
    title: 'DevMate instance status',
    description: 'Show the current connection, access, Runner, request-policy, and authenticated-principal state.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText(publicDeployment(readConfig())));

  register('deployment_readiness', {
    title: 'DevMate readiness',
    description: 'Check whether the capabilities currently configured on this DevMate instance are ready.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText(readiness(readConfig())));

  register('deployment_policy_template', {
    title: 'Connection policy template',
    description: 'Return hardened ngrok or Cloudflare ingress templates without secrets.',
    inputSchema: { provider: z.enum(['ngrok', 'cloudflare-managed']).optional() },
    annotations: ro
  }, async ({ provider }) => toolText(provider
    ? policyTemplate(provider)
    : { ngrok: policyTemplate('ngrok'), cloudflare: policyTemplate('cloudflare-managed') }));

  register('team_status', {
    title: 'DevMate access status',
    description: 'Show current principal, members, leases, sessions, connection, Runners, and readiness.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText(teamStatus()));

  register('team_configure', {
    title: 'Configure DevMate capabilities',
    description: 'Configure the public connection, workspace lease policy, and request policy. Requires owner.',
    inputSchema: {
      tunnelProvider: z.enum(TUNNEL_PROVIDERS).optional(),
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
    const config = applyTeamConfigurationPatch(readConfig(), patch);
    writeConfig(config);
    await audit('team_configure', {
      principalId: principalNow().id,
      connectionProvider: config.connection.provider,
      memberCount: config.team.members.length
    });
    return toolText({ configured: true, instance: publicDeployment(config), readiness: readiness(config) });
  });

  register('team_member_list', {
    title: 'List DevMate team members',
    description: 'List member identities, roles, scopes, expiry, and token versions without exposing token hashes.',
    inputSchema: {}, annotations: ro
  }, async () => {
    const config = normalizeInstanceConfig(readConfig());
    return toolText({ members: config.team.members.map(memberPublic) });
  });

  register('team_member_create', {
    title: 'Create DevMate team member',
    description: 'Create a member identity with explicit workspace scope and return its token once. Requires owner.',
    inputSchema: {
      id: z.string().max(120).optional(), name: z.string().min(1).max(200), role: z.enum(TEAM_ROLES).optional(),
      workspaceIds: z.array(z.string().min(1).max(300)).min(1).max(100), expiresAt: z.string().datetime().optional()
    }, annotations: rw
  }, async input => {
    const config = normalizeInstanceConfig(readConfig());
    const result = createTeamMember(config, { ...input, workspaceIds: workspaceIds(config, input.workspaceIds) });
    writeConfig(config);
    await audit('team_member_create', { principalId: principalNow().id, memberId: result.member.id, role: result.member.role, workspaceIds: result.member.workspaceIds });
    return toolText({ ...result, warning: 'The token is shown once. Store it in an approved secret manager and do not commit it.' });
  });

  register('team_member_update', {
    title: 'Update DevMate team member', description: 'Update role, explicit workspace scopes, expiry, or enabled state. Requires owner.',
    inputSchema: { id: z.string().min(1), name: z.string().max(200).optional(), role: z.enum(TEAM_ROLES).optional(), workspaceIds: z.array(z.string().min(1).max(300)).min(1).max(100).optional(), expiresAt: z.string().datetime().nullable().optional(), disabled: z.boolean().optional() },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, ...patch }) => {
    const config = normalizeInstanceConfig(readConfig());
    if (patch.workspaceIds !== undefined) patch.workspaceIds = workspaceIds(config, patch.workspaceIds);
    const member = updateTeamMember(config, id, patch);
    writeConfig(config);
    await audit('team_member_update', { principalId: principalNow().id, memberId: id, keys: Object.keys(patch) });
    return toolText({ member });
  });

  register('team_member_rotate', {
    title: 'Rotate DevMate team token', description: 'Invalidate the old member token and return a new token once. Requires owner.',
    inputSchema: { id: z.string().min(1) }, annotations: rw
  }, async ({ id }) => {
    const config = normalizeInstanceConfig(readConfig());
    const result = rotateTeamMemberToken(config, id);
    writeConfig(config);
    await audit('team_member_rotate', { principalId: principalNow().id, memberId: id });
    return toolText({ ...result, warning: 'The replacement token is shown once. Update the team secret and revoke old copies.' });
  });

  register('team_member_revoke', {
    title: 'Revoke DevMate team member', description: 'Disable a member identity immediately. Requires owner.',
    inputSchema: { id: z.string().min(1) }, annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const config = normalizeInstanceConfig(readConfig());
    const member = revokeTeamMember(config, id);
    writeConfig(config);
    await audit('team_member_revoke', { principalId: principalNow().id, memberId: id });
    return toolText({ member });
  });

  register('team_activity_status', {
    title: 'DevMate team activity', description: 'Show recent authenticated MCP clients, request counts, roles, and session IDs. Requires maintainer or owner.',
    inputSchema: { activeWithinMinutes: z.number().int().min(1).max(1440).optional() }, annotations: ro
  }, async ({ activeWithinMinutes = 60 }) => toolText({ activities: activitySnapshot({ activeWithinMinutes }) }));
}
