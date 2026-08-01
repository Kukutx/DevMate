import { now } from './local-shared.mjs';
import { mutateDurableDocument } from './durable-state.mjs';
import { compactJobStore } from './job-store-limits.mjs';
import { issueRunnerClaimInStore, normalizeRunnerClaimStore } from './runner-claim-fencing.mjs';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeJobStore(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    jobs: Array.isArray(source.jobs) ? source.jobs : [],
    runners: Array.isArray(source.runners) ? source.runners : [],
    drain: source.drain && typeof source.drain === 'object'
      ? source.drain
      : { active: false, startedAt: null, startedBy: null, reason: '' }
  };
}

function appendEvent(job, type, detail = {}) {
  job.events ||= [];
  job.events.push({ time: now(), type, detail: clone(detail) });
  if (job.events.length > 200) job.events = job.events.slice(-200);
}

function runnerMatches(job, runner) {
  if (!runner || runner.status !== 'online') return false;
  if (runner.workspaceIds?.length && job.workspaceId && !runner.workspaceIds.includes(job.workspaceId)) return false;
  const capabilities = new Set(Array.isArray(runner.capabilities) ? runner.capabilities : []);
  return (Array.isArray(job.requiredCapabilities) ? job.requiredCapabilities : []).every(value => capabilities.has(value));
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
    requiredCapabilities: [...(job.requiredCapabilities || [])],
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
  return mutateDurableDocument(document => {
    const store = normalizeJobStore(document.namespaces.jobs);
    compactJobStore(store);
    if (store.drain.active) return null;
    const runner = store.runners.find(item => item.id === owner);
    if (!runner || runner.status !== 'online') throw new Error(`Runner is not online: ${owner}`);
    const running = store.jobs.filter(job => job.runnerId === owner && job.status === 'running').length;
    if (running >= Number(runner.maxConcurrent || 1)) return null;
    const job = selectCandidate(store, runner);
    if (!job) return null;
    const fromStatus = job.status;
    job.status = 'running';
    job.runnerId = owner;
    job.startedAt ||= now();
    job.updatedAt = now();
    job.leaseExpiresAt = new Date(Date.now() + Math.min(300, Math.max(15, Number(leaseSeconds) || 60)) * 1000).toISOString();
    if (fromStatus !== 'waiting_approval' && fromStatus !== 'blocked_lease') job.attempts += 1;
    appendEvent(job, 'claimed', { runnerId: owner, fromStatus, attempt: job.attempts, fenced: true });
    runner.runningJobs = running + 1;

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

export const __test = { appendEvent, normalizeJobStore, publicJob, runnerMatches, selectCandidate };
