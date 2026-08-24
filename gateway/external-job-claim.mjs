import { now } from './local-shared.mjs';
import { mutateDurableDocument } from './durable-state.mjs';
import { assertJobStoreCapacity, compactJobStore } from './job-store-limits.mjs';
import { issueRunnerClaimInStore, normalizeRunnerClaimStore } from './runner-claim-fencing.mjs';
import { defaultedInteger } from './strict-config.mjs';

const JOB_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'blocked_lease', 'succeeded', 'failed', 'cancelled']);
const RUNNER_STATUSES = new Set(['online', 'offline']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stateError(message, detail = {}) {
  const error = new Error(`External job claim durable state is invalid: ${message}`);
  error.code = 'external_job_claim_state_invalid';
  Object.assign(error, detail);
  return error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function emptyJobStore() {
  return {
    version: 1,
    jobs: [],
    runners: [],
    drain: { active: false, startedAt: null, startedBy: null, reason: '' }
  };
}

function normalizeJobStore(value) {
  if (value === undefined) return emptyJobStore();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('jobs namespace root must be an object');
  if (value.version !== 1) throw stateError(`unsupported jobs namespace version ${String(value.version)}`, { stateVersion: value.version ?? null });
  if (!Array.isArray(value.jobs) || !Array.isArray(value.runners)) throw stateError('jobs and runners must be arrays');
  if (!value.drain || typeof value.drain !== 'object' || Array.isArray(value.drain) || typeof value.drain.active !== 'boolean') {
    throw stateError('drain must be an object with a boolean active flag');
  }

  const jobIds = new Set();
  for (const [index, job] of value.jobs.entries()) {
    if (!job || typeof job !== 'object' || Array.isArray(job) || !nonEmpty(job.id) || !JOB_STATUSES.has(job.status)) {
      throw stateError(`job ${index} has invalid identity or status`, { jobIndex: index, jobId: job?.id || null });
    }
    if (jobIds.has(job.id)) throw stateError(`duplicate job id ${job.id}`, { jobId: job.id });
    if (!job.requestedBy || typeof job.requestedBy !== 'object' || Array.isArray(job.requestedBy) || !nonEmpty(job.requestedBy.id)) {
      throw stateError(`job ${job.id} has invalid requester identity`, { jobId: job.id });
    }
    if (!Array.isArray(job.requiredCapabilities)) throw stateError(`job ${job.id} requiredCapabilities must be an array`, { jobId: job.id });
    jobIds.add(job.id);
  }

  const runnerIds = new Set();
  for (const [index, runner] of value.runners.entries()) {
    if (!runner || typeof runner !== 'object' || Array.isArray(runner) || !nonEmpty(runner.id) || !RUNNER_STATUSES.has(runner.status)) {
      throw stateError(`runner ${index} has invalid identity or status`, { runnerIndex: index, runnerId: runner?.id || null });
    }
    if (runnerIds.has(runner.id)) throw stateError(`duplicate runner id ${runner.id}`, { runnerId: runner.id });
    if (!Array.isArray(runner.capabilities) || !Array.isArray(runner.workspaceIds)) {
      throw stateError(`runner ${runner.id} capability/workspace scopes must be arrays`, { runnerId: runner.id });
    }
    runnerIds.add(runner.id);
  }
  return value;
}

function appendEvent(job, type, detail = {}) {
  job.events ||= [];
  job.events.push({ time: now(), type, detail: clone(detail) });
  if (job.events.length > 200) job.events = job.events.slice(-200);
}

function runnerMatches(job, runner) {
  if (!runner || runner.status !== 'online') return false;
  if (runner.workspaceIds.length && job.workspaceId && !runner.workspaceIds.includes(job.workspaceId)) return false;
  const capabilities = new Set(runner.capabilities);
  return job.requiredCapabilities.every(value => capabilities.has(value));
}

function publicJob(job) {
  return {
    id: job.id,
    title: job.title,
    tool: job.tool,
    status: job.status,
    priority: job.priority,
    workspaceId: job.workspaceId || null,
    requestedBy: clone(job.requestedBy),
    requiredCapabilities: [...job.requiredCapabilities],
    runnerId: job.runnerId || null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    timeoutMs: job.timeoutMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    nextRunAt: job.nextRunAt || null,
    leaseExpiresAt: job.leaseExpiresAt || null,
    cancelRequestedAt: job.cancelRequestedAt || null,
    error: job.error || null,
    artifacts: clone(job.artifacts || []),
    events: clone(job.events || []),
    arguments: clone(job.arguments || {})
  };
}

function selectCandidate(store, runner, timestamp = Date.now()) {
  return store.jobs.filter(job =>
    ['queued', 'waiting_approval', 'blocked_lease'].includes(job.status) &&
    !job.cancelRequestedAt &&
    Date.parse(job.nextRunAt || 0) <= timestamp &&
    runnerMatches(job, runner)
  ).sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}

export function claimExternalJob({ runnerId, leaseSeconds = 60 }) {
  const owner = String(runnerId || '').trim();
  if (!owner) throw new Error('runnerId is required');
  const lease = defaultedInteger(leaseSeconds, 60, 15, 300, 'Runner leaseSeconds');
  return mutateDurableDocument(document => {
    const store = normalizeJobStore(document.namespaces.jobs);
    compactJobStore(store);
    if (store.drain.active) return null;
    const runner = store.runners.find(item => item.id === owner);
    if (!runner || runner.status !== 'online') throw new Error(`Runner is not online: ${owner}`);
    const maxConcurrent = defaultedInteger(runner.maxConcurrent, 1, 1, 16, 'Runner maxConcurrent');
    const running = store.jobs.filter(job => job.runnerId === owner && job.status === 'running').length;
    if (running >= maxConcurrent) return null;
    const job = selectCandidate(store, runner);
    if (!job) return null;
    const fromStatus = job.status;
    job.status = 'running';
    job.runnerId = owner;
    job.startedAt ||= now();
    job.updatedAt = now();
    job.leaseExpiresAt = new Date(Date.now() + lease * 1000).toISOString();
    if (fromStatus !== 'waiting_approval' && fromStatus !== 'blocked_lease') job.attempts += 1;
    appendEvent(job, 'claimed', { runnerId: owner, fromStatus, attempt: job.attempts, fenced: true });
    runner.runningJobs = running + 1;
    assertJobStoreCapacity(store);

    const claims = normalizeRunnerClaimStore(document.namespaces['runner-claims']);
    const claim = issueRunnerClaimInStore(claims, {
      jobId: job.id,
      runnerId: owner,
      leaseExpiresAt: job.leaseExpiresAt
    });
    document.namespaces.jobs = store;
    document.namespaces['runner-claims'] = claims;
    return { job: publicJob(job), claim };
  });
}

export const __test = {
  JOB_STATUSES,
  RUNNER_STATUSES,
  appendEvent,
  emptyJobStore,
  normalizeJobStore,
  publicJob,
  runnerMatches,
  selectCandidate,
  stateError
};