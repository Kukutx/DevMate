import { z } from 'zod';
import { audit, readConfig, toolText } from './local-shared.mjs';
import { authorizeToolCall, normalizeDeploymentConfig } from './team-access.mjs';
import { assertWorkspaceLease } from './workspace-leases.mjs';
import { principalNow } from './team-tool-data.mjs';
import {
  cancelDrain,
  cancelJob,
  createJob,
  drainStatus,
  getJob,
  listJobs,
  listRunners,
  retryJob,
  startDrain
} from './job-queue.mjs';
import { jobRuntimeStatus, jobTarget, jobTargetCatalog } from './job-runtime.mjs';

const jobStatusSchema = z.enum(['queued', 'running', 'waiting_approval', 'blocked_lease', 'succeeded', 'failed', 'cancelled']);

function targetAuthorization(target, args, principal) {
  const config = normalizeDeploymentConfig(readConfig());
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
  return authorized;
}

function ensureVisible(job, principal) {
  if (principal.workspaceIds?.length && job.workspaceId && !principal.workspaceIds.includes(job.workspaceId)) throw new Error(`Principal ${principal.id} is not allowed to access job workspace ${job.workspaceId}`);
  if (!['owner', 'maintainer'].includes(principal.role) && job.requestedBy.id !== principal.id) throw new Error(`Job ${job.id} belongs to ${job.requestedBy.name || job.requestedBy.id}`);
  return job;
}

export function registerJobTools(register, annotations) {
  const { ro, rw } = annotations;

  register('job_target_catalog', {
    title: 'DevMate job target catalog',
    description: 'List reviewed tools that may be executed by the durable embedded job runner.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ targets: jobTargetCatalog() }));

  register('job_submit', {
    title: 'Submit durable DevMate job',
    description: 'Queue a reviewed build, validation, Browser QA, Godot acceptance, report, or safe Git-save tool for durable execution. Credential-like arguments and arbitrary shell commands are rejected.',
    inputSchema: {
      tool: z.string().min(1).max(200),
      arguments: z.record(z.string(), z.unknown()).optional(),
      title: z.string().max(300).optional(),
      priority: z.number().int().min(0).max(100).optional(),
      maxAttempts: z.number().int().min(1).max(5).optional(),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
      requiredCapabilities: z.array(z.string().min(1).max(100)).max(50).optional(),
      artifactPaths: z.array(z.string().min(1).max(2000)).max(100).optional()
    },
    annotations: rw
  }, async ({ tool, arguments: args = {}, title = '', priority = 50, maxAttempts = 2, timeoutMs = 900000, requiredCapabilities = [], artifactPaths = [] }) => {
    const target = jobTarget(tool);
    if (!target) throw new Error(`Tool is not currently available as a durable job target: ${tool}`);
    if (tool === 'git_save' && args.push) throw new Error('Durable git_save jobs cannot push. Review and publish synchronously through the approval flow.');
    const principal = principalNow();
    const authorized = targetAuthorization(target, args, principal);
    const capabilities = [...new Set([...target.requiredCapabilities, ...requiredCapabilities.map(value => String(value).trim().toLowerCase()).filter(Boolean)])];
    const job = createJob({
      principal,
      tool,
      args,
      workspaceId: authorized.workspaceId,
      title,
      priority,
      maxAttempts,
      timeoutMs,
      requiredCapabilities: capabilities,
      artifactPaths
    });
    await audit('job_submit', { principalId: principal.id, jobId: job.id, tool, workspace: authorized.workspaceId, priority, maxAttempts });
    return toolText({ job });
  });

  register('job_list', {
    title: 'List DevMate jobs',
    description: 'List durable jobs visible to the current principal.',
    inputSchema: { status: jobStatusSchema.optional(), workspaceId: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
    annotations: ro
  }, async ({ status, workspaceId, limit = 100 }) => toolText({ jobs: listJobs({ principal: principalNow(), status, workspaceId, limit }) }));

  register('job_status', {
    title: 'DevMate job status',
    description: 'Read one durable job, including bounded events and indexed artifacts.',
    inputSchema: { id: z.string().min(1), includeArguments: z.boolean().optional(), includeResult: z.boolean().optional() },
    annotations: ro
  }, async ({ id, includeArguments = false, includeResult = true }) => {
    const principal = principalNow();
    return toolText({ job: ensureVisible(getJob(id, { includeArguments, includeResult }), principal) });
  });

  register('job_artifacts', {
    title: 'DevMate job artifacts',
    description: 'List indexed files produced by a completed durable job.',
    inputSchema: { id: z.string().min(1) },
    annotations: ro
  }, async ({ id }) => {
    const principal = principalNow();
    const job = ensureVisible(getJob(id), principal);
    return toolText({ jobId: job.id, status: job.status, artifacts: job.artifacts });
  });

  register('job_cancel', {
    title: 'Cancel DevMate job',
    description: 'Cancel a queued/deferred job immediately or request cooperative cancellation of a running job.',
    inputSchema: { id: z.string().min(1), force: z.boolean().optional() },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, force = false }) => {
    const principal = principalNow();
    const result = cancelJob({ id, principal, force });
    await audit('job_cancel', { principalId: principal.id, jobId: id, force, cancelled: result.cancelled });
    return toolText(result);
  });

  register('job_retry', {
    title: 'Retry DevMate job',
    description: 'Requeue a failed, cancelled, approval-blocked, or lease-blocked job after correcting its prerequisite.',
    inputSchema: { id: z.string().min(1) },
    annotations: rw
  }, async ({ id }) => {
    const principal = principalNow();
    const existing = ensureVisible(getJob(id, { includeArguments: true }), principal);
    const target = jobTarget(existing.tool);
    if (!target) throw new Error(`Job target is not currently available: ${existing.tool}`);
    targetAuthorization(target, existing.arguments || {}, principal);
    const job = retryJob({ id, principal });
    await audit('job_retry', { principalId: principal.id, jobId: id, tool: job.tool, workspace: job.workspaceId });
    return toolText({ job });
  });

  register('runner_status', {
    title: 'DevMate runner status',
    description: 'Show embedded runner capabilities, availability, concurrency, and current runtime state.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ runners: listRunners(), runtime: jobRuntimeStatus() }));

  register('deployment_drain_status', {
    title: 'DevMate drain status',
    description: 'Show whether the gateway is draining before maintenance or upgrade.',
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ drain: drainStatus(), runtime: jobRuntimeStatus() }));

  register('deployment_drain_start', {
    title: 'Start DevMate drain',
    description: 'Stop accepting new team mutations and stop claiming queued jobs while allowing current jobs to finish. Requires maintainer or owner.',
    inputSchema: { reason: z.string().max(1000).optional() },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ reason = '' }) => {
    const principal = principalNow();
    const drain = startDrain({ principal, reason });
    await audit('deployment_drain_start', { principalId: principal.id, reason });
    return toolText({ drain, runtime: jobRuntimeStatus() });
  });

  register('deployment_drain_cancel', {
    title: 'Cancel DevMate drain',
    description: 'Resume team mutations and durable job claiming after maintenance. Requires maintainer or owner.',
    inputSchema: {},
    annotations: { ...rw, idempotentHint: true }
  }, async () => {
    const principal = principalNow();
    const result = cancelDrain({ principal });
    await audit('deployment_drain_cancel', { principalId: principal.id, cancelled: result.cancelled });
    return toolText(result);
  });
}

export const __test = { ensureVisible, targetAuthorization };
