import { z } from 'zod';
import { audit, readConfig, toolText, writeConfig } from './local-shared.mjs';
import {
  approvalPolicy,
  approvalRequest,
  cancelApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests
} from './approvals.mjs';
import { durableStateStatus } from './durable-state.mjs';
import { metricsSnapshot } from './observability.mjs';
import { principalNow } from './team-tool-data.mjs';

function assertOwner(principal) {
  if (principal?.role !== 'owner') throw new Error('This operation requires the owner role');
}

function assertMaintainer(principal) {
  if (!['owner', 'maintainer'].includes(principal?.role)) throw new Error('This operation requires maintainer or owner role');
}

export function registerApprovalTools(register, annotations) {
  const { ro } = annotations;
  const control = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  register('team_approval_policy_status', {
    title: 'DevMate approval policy',
    description: 'Show whether dual-control approval is enabled and which capabilities or tools require it.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ policy: approvalPolicy(readConfig()) }));

  register('team_approval_configure', {
    title: 'Configure DevMate approval policy',
    description: 'Configure production dual-control approval rules. Requires owner.',
    inputSchema: {
      enabled: z.boolean().optional(),
      requiredCapabilities: z.array(z.enum(['read', 'validate', 'write', 'execute', 'git', 'publish', 'admin'])).max(20).optional(),
      requiredTools: z.array(z.string().min(1).max(200)).max(200).optional(),
      ttlSeconds: z.number().int().min(300).max(86400).optional(),
      separationOfDuties: z.boolean().optional(),
      ownerBypass: z.boolean().optional()
    },
    annotations: control
  }, async patch => {
    const principal = principalNow();
    assertOwner(principal);
    const config = readConfig();
    config.team ||= {};
    config.team.approvals ||= {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) config.team.approvals[key] = value;
    }
    writeConfig(config);
    await audit('approval_policy_configure', { principalId: principal.id, keys: Object.keys(patch) });
    return toolText({ configured: true, policy: approvalPolicy(config) });
  });

  register('team_approval_list', {
    title: 'List DevMate approval requests',
    description: 'List approval requests visible to the current principal. Maintainers and owners can review requests in their workspace scope; other members see their own requests.',
    inputSchema: {
      status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'consumed', 'expired']).optional(),
      workspaceId: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional()
    },
    annotations: ro
  }, async ({ status, workspaceId, limit = 100 }) => toolText({
    requests: listApprovalRequests({ principal: principalNow(), status, workspaceId, limit })
  }));

  register('team_approval_status', {
    title: 'DevMate approval request status',
    description: 'Read one approval request visible to the current principal.',
    inputSchema: { id: z.string().min(1) },
    annotations: ro
  }, async ({ id }) => toolText({ request: approvalRequest(id, principalNow()) }));

  register('team_approval_decide', {
    title: 'Decide DevMate approval request',
    description: 'Approve or reject a pending request. Requires a different maintainer or owner when separation of duties is enabled.',
    inputSchema: {
      id: z.string().min(1),
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(1000).optional()
    },
    annotations: control
  }, async ({ id, decision, note = '' }) => {
    const principal = principalNow();
    assertMaintainer(principal);
    const request = decideApprovalRequest({ id, principal, decision, note, config: readConfig() });
    await audit('approval_decide', {
      principalId: principal.id,
      approvalId: id,
      decision,
      tool: request.tool,
      workspace: request.workspaceId
    });
    return toolText({ request });
  });

  register('team_approval_cancel', {
    title: 'Cancel DevMate approval request',
    description: 'Cancel a pending or approved request before it is consumed. Requesters may cancel their own requests; maintainers and owners may cancel requests in their scope.',
    inputSchema: { id: z.string().min(1), note: z.string().max(1000).optional() },
    annotations: control
  }, async ({ id, note = '' }) => {
    const principal = principalNow();
    const result = cancelApprovalRequest({ id, principal, note });
    await audit('approval_cancel', {
      principalId: principal.id,
      approvalId: id,
      cancelled: result.cancelled
    });
    return toolText(result);
  });

  register('deployment_metrics', {
    title: 'DevMate deployment metrics',
    description: 'Return bounded request and tool metrics for operational diagnostics. Requires maintainer or owner.',
    inputSchema: {},
    annotations: ro
  }, async () => {
    assertMaintainer(principalNow());
    return toolText(metricsSnapshot());
  });

  register('deployment_runtime_state', {
    title: 'DevMate durable runtime state',
    description: 'Show durable state namespaces, file size, recovery information, and instance lock status. Requires maintainer or owner.',
    inputSchema: {},
    annotations: ro
  }, async () => {
    assertMaintainer(principalNow());
    return toolText(durableStateStatus());
  });
}
