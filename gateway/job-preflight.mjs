import { readConfig } from './local-shared.mjs';
import { ensureToolApproval } from './approvals.mjs';
import { jobTarget } from './job-runtime.mjs';
import { authorizeToolCall, normalizeInstanceConfig } from './team-access.mjs';
import { acquireWorkspaceLeaseHold, assertWorkspaceLease } from './workspace-leases.mjs';

export function preflightQueuedJob(job, { holdWorkspaceLease = false } = {}) {
  const target = jobTarget(job?.tool);
  if (!target) {
    const error = new Error(`Job target is not currently available: ${job?.tool || 'unknown'}`);
    error.code = 'job_target_unavailable';
    throw error;
  }
  const config = normalizeInstanceConfig(readConfig());
  const principal = job?.requestedBy || null;
  const args = job?.arguments || {};
  const authorized = authorizeToolCall({
    name: target.name,
    annotations: target.config?.annotations || {},
    args,
    config,
    principal
  });
  assertWorkspaceLease({
    workspaceId: authorized.workspaceId,
    principal: authorized.principal,
    capability: authorized.capability,
    config
  });
  const approval = ensureToolApproval({
    config,
    principal: authorized.principal,
    tool: target.name,
    capability: authorized.capability,
    workspaceId: authorized.workspaceId,
    args
  });
  const leaseHold = holdWorkspaceLease
    ? acquireWorkspaceLeaseHold({
      workspaceId: authorized.workspaceId,
      principal: authorized.principal,
      capability: authorized.capability,
      config,
      holdMs: Math.max(60_000, Number(job?.timeoutMs) || 900_000) + 60_000,
      purpose: `job:${job?.id || target.name}`
    })
    : null;
  return { target, authorized, approval, leaseHold };
}
