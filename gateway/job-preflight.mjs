import { readConfig } from './local-shared.mjs';
import { ensureToolApproval } from './approvals.mjs';
import { jobTarget } from './job-runtime.mjs';
import { authorizeToolCall, normalizeDeploymentConfig } from './team-access.mjs';
import { assertWorkspaceLease } from './workspace-leases.mjs';

export function preflightQueuedJob(job) {
  const target = jobTarget(job?.tool);
  if (!target) {
    const error = new Error(`Job target is not currently available: ${job?.tool || 'unknown'}`);
    error.code = 'job_target_unavailable';
    throw error;
  }
  const config = normalizeDeploymentConfig(readConfig());
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
  return { target, authorized, approval };
}
