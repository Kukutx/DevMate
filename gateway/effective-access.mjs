import { z } from 'zod';
import { permissionPolicyGeneration, permissionPolicySnapshot } from '../shared/permission-config.cjs';
import { readConfig, toolText } from './local-shared.mjs';
import {
  currentTeamPrincipal,
  fallbackLocalPrincipal,
  normalizeInstanceConfig,
  roleAllows
} from './team-access.mjs';
import { publicConversationWorkspaceBinding } from './conversation-workspaces.mjs';
import { requestConversationScope, requestPrincipal } from './request-context.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';
import { workspaceLease, __test as workspaceLeaseTest } from './workspace-leases.mjs';

const WORKSPACE_CAPABILITIES = Object.freeze(['read', 'validate', 'write', 'execute', 'git', 'publish']);
const MUTATING_CAPABILITIES = new Set(['write', 'execute', 'git', 'publish']);

function compactBinding(binding) {
  if (!binding) return null;
  return {
    workspaceId: binding.workspaceId,
    name: binding.name,
    mode: binding.mode,
    source: binding.source,
    implicit: !!binding.implicit
  };
}

function compactWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role || (workspace.reference ? 'reference' : 'workspace'),
    reference: !!workspace.reference,
    mode: workspace.mode || (workspace.reference ? 'readonly' : 'workspace-write')
  };
}

function blocker(code, message, detail = {}) {
  return { code, message, ...detail };
}

function commonWorkspaceScopeBlocker(principal, workspace) {
  if (principal?.source !== 'oauth-member') return null;
  if (Array.isArray(principal.workspaceIds) && principal.workspaceIds.includes(workspace.id)) return null;
  return blocker(
    'principal_workspace_scope',
    `Principal ${principal.id} is not scoped to workspace ${workspace.id}`,
    { workspaceId: workspace.id }
  );
}

function mutationBlockers({ config, principal, workspace, capability, lease, permissions }) {
  const blockers = [];
  if (permissions.profile === 'readOnly') {
    blockers.push(blocker('permission_profile_readonly', 'The shared DevMate permission profile is readOnly'));
  }
  if (workspace.reference || workspace.mode === 'readonly') {
    blockers.push(blocker('workspace_readonly', `Workspace ${workspace.id} is readonly/reference`, { workspaceId: workspace.id }));
  }
  if (workspaceLeaseTest.leaseRequired({ workspaceId: workspace.id, principal, capability, config })) {
    if (!lease) {
      blockers.push(blocker(
        'workspace_lease_required',
        `Workspace ${workspace.id} requires a lease before ${capability} operations`,
        { workspaceId: workspace.id }
      ));
    } else if (lease.principalId !== principal?.id) {
      blockers.push(blocker(
        'workspace_leased_by_other',
        `Workspace ${workspace.id} is leased by another principal`,
        { workspaceId: workspace.id, leasePrincipalId: lease.principalId }
      ));
    }
  }
  return blockers;
}

export function effectiveAccessSnapshot({ config, principal, workspace, binding = null, lease = null }) {
  normalizeInstanceConfig(config);
  const permissions = permissionPolicySnapshot(config);
  const scopeBlocker = commonWorkspaceScopeBlocker(principal, workspace);
  const capabilities = {};

  for (const capability of WORKSPACE_CAPABILITIES) {
    const blockers = [];
    if (!roleAllows(principal.role, capability)) {
      blockers.push(blocker(
        'role_capability_missing',
        `Role ${principal.role} does not grant ${capability}`,
        { role: principal.role, capability }
      ));
    }
    if (scopeBlocker) blockers.push(scopeBlocker);
    if (MUTATING_CAPABILITIES.has(capability)) {
      blockers.push(...mutationBlockers({ config, principal, workspace, capability, lease, permissions }));
    }
    capabilities[capability] = { allowed: blockers.length === 0, blockers };
  }

  return {
    permissionPolicy: {
      ...permissions,
      generation: permissionPolicyGeneration(config)
    },
    principal: {
      id: principal.id,
      name: principal.name,
      role: principal.role,
      source: principal.source
    },
    workspace: compactWorkspace(workspace),
    conversationBinding: compactBinding(binding),
    lease: {
      requiredForRemoteMutations: config.team?.requireWorkspaceLeaseForWrites === true && principal.source !== 'local',
      current: lease ? {
        id: lease.id,
        workspaceId: lease.workspaceId,
        principalId: lease.principalId,
        principalName: lease.principalName,
        expiresAt: lease.expiresAt,
        activeHoldUntil: lease.activeHoldUntil || null
      } : null
    },
    capabilities,
    conditionalGuards: {
      dangerousOperationsGuarded: permissions.profile !== 'fullAccess' && permissions.blockDangerousOperations !== false,
      confirmBeforePush: permissions.confirmBeforePush === true,
      directoryMutationsAllowed: permissions.allowDirectoryMutations === true
    }
  };
}

export function currentEffectiveAccess(workspaceId = '') {
  const config = normalizeInstanceConfig(readConfig());
  const principal = currentTeamPrincipal(requestPrincipal() || fallbackLocalPrincipal(), config);
  const workspace = resolveWorkspace(config, workspaceId);
  const binding = publicConversationWorkspaceBinding(config, requestConversationScope());
  const lease = workspaceLease(workspace.id);
  return effectiveAccessSnapshot({ config, principal, workspace, binding, lease });
}

export function installEffectiveAccessCapability(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.effective-access',
    order: 25,
    initialize(server) {
      server.registerTool('effective_access_status', {
        title: 'Effective access status',
        description: 'Explain the effective DevMate access for one workspace, including shared permission policy, authenticated role, conversation routing, readonly workspace state, workspace lease requirements, and concrete blockers.',
        inputSchema: { workspaceId: z.string().max(200).optional() },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
      }, async ({ workspaceId = '' }) => toolText(currentEffectiveAccess(workspaceId)));
    }
  });
}

export const __test = {
  MUTATING_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  commonWorkspaceScopeBlocker,
  mutationBlockers
};
