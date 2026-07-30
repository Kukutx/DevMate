import { z } from 'zod';
import { audit, readConfig, toolText } from './local-shared.mjs';
import {
  approvalPolicy,
  approvalRequest,
  cancelApprovalRequest,
  decideApprovalRequest,
  listApprovalRequests
} from './approvals.mjs';
import { principalNow } from './team-tool-data.mjs';

export function registerApprovalTools(register, annotations) {
  const { ro, rw } = annotations;

  register('approval_policy_status', {
    title: 'DevMate approval policy',
    description: 'Show whether dual-control approval is enabled and which capabilities or tools require it.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ policy: approvalPolicy(readConfig()) }));

  register('approval_list', {
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

  register('approval_status', {
    title: 'DevMate approval request status',
    description: 'Read one approval request visible to the current principal.',
    inputSchema: { id: z.string().min(1) },
    annotations: ro
  }, async ({ id }) => toolText({ request: approvalRequest(id, principalNow()) }));

  register('approval_decide', {
    title: 'Decide DevMate approval request',
    description: 'Approve or reject a pending request. Requires a different maintainer or owner when separation of duties is enabled.',
    inputSchema: {
      id: z.string().min(1),
      decision: z.enum(['approve', 'reject']),
      note: z.string().max(1000).optional()
    },
    annotations: rw
  }, async ({ id, decision, note = '' }) => {
    const principal = principalNow();
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

  register('approval_cancel', {
    title: 'Cancel DevMate approval request',
    description: 'Cancel a pending or approved request before it is consumed. Requesters may cancel their own requests; maintainers and owners may cancel requests in their scope.',
    inputSchema: { id: z.string().min(1), note: z.string().max(1000).optional() },
    annotations: { ...rw, idempotentHint: true }
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
}
