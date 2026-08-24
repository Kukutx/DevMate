import { readConfig } from './local-shared.mjs';
import { ensureToolApproval } from './approvals.mjs';
import {
  acquireExternalJobWorkspaceHold,
  forgetExternalJobWorkspaceHold,
  releaseExternalJobWorkspaceHold
} from './external-job-workspace-holds.mjs';
import { jobTarget } from './job-runtime.mjs';
import { activeRunnerClaim } from './runner-claim-fencing.mjs';
import { authorizeToolCall, normalizeInstanceConfig } from './team-access.mjs';
import {
  acquireWorkspaceLeaseHold,
  assertWorkspaceLease,
  releaseWorkspaceLeaseHold
} from './workspace-leases.mjs';

function releasePreflightHold(job, leaseHold, mapped) {
  if (!leaseHold) return;
  if (mapped) {
    try {
      if (releaseExternalJobWorkspaceHold({ jobId: job.id, runnerId: job.runnerId })) return;
    } catch {
      // Fall through to direct release without discarding the durable mapping.
    }
  }
  let released = false;
  try {
    released = releaseWorkspaceLeaseHold({
      workspaceId: leaseHold.workspaceId,
      holdId: leaseHold.id,
      leaseId: leaseHold.leaseId,
      principalId: leaseHold.principalId
    });
  } finally {
    if (mapped && released) {
      try { forgetExternalJobWorkspaceHold({ jobId: job.id, runnerId: job.runnerId }); } catch {}
    }
  }
}

export function preflightQueuedJob(job, options = {}) {
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

  // External claims are the only queued execution path that leaves this
  // Gateway process. Infer that boundary from the durable claim so callers
  // cannot accidentally omit the operation-duration workspace hold.
  const externalClaim = activeRunnerClaim(job?.id, job?.runnerId);
  const holdWorkspaceLease = options.holdWorkspaceLease === undefined
    ? !!externalClaim
    : options.holdWorkspaceLease === true;
  let leaseHold = null;
  let mapped = false;
  if (holdWorkspaceLease && externalClaim && job?.runnerId && job?.id) {
    const external = acquireExternalJobWorkspaceHold({
      jobId: job.id,
      runnerId: job.runnerId,
      workspaceId: authorized.workspaceId,
      principal: authorized.principal,
      capability: authorized.capability,
      config,
      holdMs: Math.max(60_000, Number(job?.timeoutMs) || 900_000) + 60_000,
      purpose: `job:${job?.id || target.name}`
    });
    leaseHold = external.hold;
    mapped = !!leaseHold;
  } else if (holdWorkspaceLease) {
    leaseHold = acquireWorkspaceLeaseHold({
      workspaceId: authorized.workspaceId,
      principal: authorized.principal,
      capability: authorized.capability,
      config,
      holdMs: Math.max(60_000, Number(job?.timeoutMs) || 900_000) + 60_000,
      purpose: `job:${job?.id || target.name}`
    });
  }

  try {
    // Consume a one-shot approval only after the mutation boundary is fully
    // established. If approval fails, the hold is released below.
    const approval = ensureToolApproval({
      config,
      principal: authorized.principal,
      tool: target.name,
      capability: authorized.capability,
      workspaceId: authorized.workspaceId,
      args
    });
    return { target, authorized, approval, leaseHold };
  } catch (error) {
    releasePreflightHold(job, leaseHold, mapped);
    throw error;
  }
}

export const __test = { releasePreflightHold };
