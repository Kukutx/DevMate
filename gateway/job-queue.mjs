import crypto from 'node:crypto';
import { now, redactSensitiveString } from './local-shared.mjs';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';
import {
  MAX_ACTIVE_JOBS,
  MAX_JOB_STORE_BYTES,
  MAX_RETAINED_JOBS,
  MAX_RUNNERS,
  activeJobCount,
  assertCanActivateJob,
  assertJobStoreCapacity,
  compactJobStore,
  jobStoreBytes
} from './job-store-limits.mjs';

const NAMESPACE = 'jobs';
const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'blocked_lease']);
const FINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|credential/i;
const SENSITIVE_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{10,}|[?&](?:token|secret|password|key)=/i;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function emptyStore() {
  return { version: 1, jobs: [], runners: [], drain: { active: false, startedAt: null, startedBy: null, reason: '' } };
}

function readStore() {
  const raw = readDurableNamespace(NAMESPACE, emptyStore());
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyStore();
  return {
    version: 1,
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    runners: Array.isArray(raw.runners) ? raw.runners : [],
    drain: raw.drain && typeof raw.drain === 'object' ? raw.drain : emptyStore().drain
  };
}

function writeStore(store) {
  assertJobStoreCapacity(store, { enforceActive: false });
  return writeDurableNamespace(NAMESPACE, store);
}

function cleanString(value, max = 500) {
  return redactSensitiveString(String(value || '').trim()).slice(0, max);
}

function assertSafeArguments(value, key = '', depth = 0) {
  if (depth > 12) throw new Error('Job arguments are too deeply nested');
  if (SENSITIVE_KEY.test(key)) throw new Error(`Job arguments cannot persist sensitive field: ${key}`);
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return;
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) throw new Error(`Job arguments contain a credential-like value at ${key || '(root)'}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`Job argument array is too large at ${key || '(root)'}`);
    value.forEach((item, index) => assertSafeArguments(item, `${key}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 500) throw new Error(`Job argument object is too large at ${key || '(root)'}`);
    for (const [childKey, child] of entries) assertSafeArguments(child, childKey, depth + 1);
    return;
  }
  throw new Error(`Unsupported job argument type at ${key || '(root)'}`);
}

function argumentBytes(args) {
  return Buffer.byteLength(JSON.stringify(args || {}), 'utf8');
}

function normalizeCapabilities(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}

function publicPrincipal(principal) {
  return {
    id: principal?.id || 'unknown',
    name: principal?.name || principal?.id || 'unknown',
    role: principal?.role || 'observer',
    source: principal?.source || 'unknown',
    workspaceIds: Array.isArray(principal?.workspaceIds) ? [...principal.workspaceIds] : []
  };
}

function event(type, detail = {}) {
  return { time: now(), type, detail: clone(detail) };
}

function appendEvent(job, type, detail = {}) {
  job.events ||= [];
  job.events.push(event(type, detail));
  if (job.events.length > 200) job.events = job.events.slice(-200);
}

function publicRunner(runner) {
  return {
    id: runner.id,
    name: runner.name,
    capabilities: [...runner.capabilities],
    workspaceIds: [...runner.workspaceIds],
    maxConcurrent: runner.maxConcurrent,
    status: runner.status,
    version: runner.version || null,
    platform: runner.platform || null,
    arch: runner.arch || null,
    registeredAt: runner.registeredAt,
    lastHeartbeatAt: runner.lastHeartbeatAt,
    runningJobs: runner.runningJobs || 0,
    labels: { ...(runner.labels || {}) }
  };
}

function publicJob(job, { includeArguments = false, includeResult = false } = {}) {
  const output = {
    id: job.id,
    title: job.title,
    tool: job.tool,
    status: job.status,
    priority: job.priority,
    workspaceId: job.workspaceId || null,
    requestedBy: { ...job.requestedBy },
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
    artifacts: Array.isArray(job.artifacts) ? clone(job.artifacts) : [],
    events: Array.isArray(job.events) ? clone(job.events) : []
  };
  if (includeArguments) output.arguments = clone(job.arguments);
  if (includeResult) output.result = clone(job.result);
  return output;
}

function runnerMatches(job, runner) {
  if (!runner || runner.status !== 'online') return false;
  if (runner.workspaceIds.length && job.workspaceId && !runner.workspaceIds.includes(job.workspaceId)) return false;
  const capabilities = new Set(runner.capabilities);
  return job.requiredCapabilities.every(value => capabilities.has(value));
}

function recover(store, at = Date.now()) {
  let changed = false;
  for (const job of store.jobs) {
    if (job.status === 'running' && Date.parse(job.leaseExpiresAt || 0) <= at) {
      job.runnerId = null;
      job.leaseExpiresAt = null;
      job.updatedAt = now();
      if (job.cancelRequestedAt) {
        job.status = 'cancelled';
        job.finishedAt = now();
        appendEvent(job, 'cancelled_after_runner_loss');
      } else if (job.attempts >= job.maxAttempts) {
        job.status = 'failed';
        job.finishedAt = now();
        job.error = 'Runner lease expired and maximum attempts were exhausted';
        appendEvent(job, 'runner_lease_expired', { exhausted: true });
      } else {
        job.status = 'queued';
        job.nextRunAt = now();
        appendEvent(job, 'runner_lease_expired', { requeued: true });
      }
      changed = true;
    }
  }
  for (const runner of store.runners) {
    if (runner.status === 'online' && Date.parse(runner.lastHeartbeatAt || 0) < at - 90000) {
      runner.status = 'offline';
      runner.runningJobs = 0;
      changed = true;
    }
  }
  const compacted = compactJobStore(store, { at });
  if (compacted.changed) changed = true;
  if (changed) writeStore(store);
  return store;
}

export function createJob({ principal, tool, args = {}, workspaceId = null, title = '', priority = 50, maxAttempts = 2, timeoutMs = 900000, requiredCapabilities = [], artifactPaths = [] }) {
  assertSafeArguments(args);
  const bytes = argumentBytes(args);
  if (bytes > 256 * 1024) throw new Error(`Job arguments exceed the 256 KiB limit (${bytes} bytes)`);
  const store = recover(readStore());
  if (store.drain.active && principal?.source === 'team-token') throw new Error(`DevMate is draining: ${store.drain.reason || 'maintenance in progress'}`);
  assertCanActivateJob(store);
  const job = {
    id: `job-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`,
    title: cleanString(title || tool, 300) || tool,
    tool: String(tool || '').trim(),
    arguments: clone(args),
    workspaceId: workspaceId || null,
    requestedBy: publicPrincipal(principal),
    priority: Math.min(100, Math.max(0, Math.trunc(Number(priority) || 50))),
    requiredCapabilities: normalizeCapabilities(requiredCapabilities),
    artifactPaths: [...new Set((artifactPaths || []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100),
    status: 'queued',
    runnerId: null,
    attempts: 0,
    maxAttempts: Math.min(5, Math.max(1, Math.trunc(Number(maxAttempts) || 2))),
    timeoutMs: Math.min(60 * 60 * 1000, Math.max(1000, Math.trunc(Number(timeoutMs) || 900000))),
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
    nextRunAt: now(),
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    error: null,
    result: null,
    artifacts: [],
    events: []
  };
  appendEvent(job, 'submitted', { argumentBytes: bytes });
  store.jobs.push(job);
  writeStore(store);
  return publicJob(job);
}

export function getJob(id, options = {}) {
  const job = recover(readStore()).jobs.find(item => item.id === id);
  if (!job) throw new Error(`Job not found: ${id}`);
  return publicJob(job, options);
}

export function listJobs({ principal, status, workspaceId, limit = 100 } = {}) {
  let jobs = recover(readStore()).jobs;
  if (principal?.workspaceIds?.length) jobs = jobs.filter(job => !job.workspaceId || principal.workspaceIds.includes(job.workspaceId));
  if (!['owner', 'maintainer'].includes(principal?.role)) jobs = jobs.filter(job => job.requestedBy.id === principal?.id);
  if (status) jobs = jobs.filter(job => job.status === status);
  if (workspaceId) jobs = jobs.filter(job => job.workspaceId === workspaceId);
  return jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map(job => publicJob(job));
}

export function cancelJob({ id, principal, force = false }) {
  const store = recover(readStore());
  const job = store.jobs.find(item => item.id === id);
  if (!job) return { cancelled: false, id, reason: 'not found' };
  const elevated = ['owner', 'maintainer'].includes(principal?.role);
  if (job.requestedBy.id !== principal?.id && !(force && elevated)) throw new Error(`Job ${id} belongs to ${job.requestedBy.name || job.requestedBy.id}`);
  if (FINAL_STATUSES.has(job.status)) return { cancelled: false, job: publicJob(job), reason: job.status };
  job.cancelRequestedAt = now();
  job.updatedAt = now();
  appendEvent(job, 'cancel_requested', { by: principal?.id || 'unknown' });
  if (job.status !== 'running') {
    job.status = 'cancelled';
    job.finishedAt = now();
    appendEvent(job, 'cancelled');
  }
  writeStore(store);
  return { cancelled: job.status === 'cancelled', cancelRequested: true, job: publicJob(job) };
}

export function retryJob({ id, principal }) {
  const store = recover(readStore());
  const job = store.jobs.find(item => item.id === id);
  if (!job) throw new Error(`Job not found: ${id}`);
  const elevated = ['owner', 'maintainer'].includes(principal?.role);
  if (job.requestedBy.id !== principal?.id && !elevated) throw new Error(`Job ${id} belongs to ${job.requestedBy.name || job.requestedBy.id}`);
  if (!['failed', 'cancelled', 'waiting_approval', 'blocked_lease'].includes(job.status)) throw new Error(`Job ${id} cannot be retried from status ${job.status}`);
  if (FINAL_STATUSES.has(job.status)) assertCanActivateJob(store);
  job.status = 'queued';
  job.runnerId = null;
  job.error = null;
  job.result = null;
  job.finishedAt = null;
  job.cancelRequestedAt = null;
  job.leaseExpiresAt = null;
  job.nextRunAt = now();
  job.updatedAt = now();
  appendEvent(job, 'retried', { by: principal?.id || 'unknown' });
  writeStore(store);
  return publicJob(job);
}

export function registerRunner({ id, name = '', capabilities = [], workspaceIds = [], maxConcurrent = 1, version = '', platform = process.platform, arch = process.arch, labels = {} }) {
  const runnerId = String(id || '').trim();
  if (!runnerId) throw new Error('runner id is required');
  const store = recover(readStore());
  let runner = store.runners.find(item => item.id === runnerId);
  const timestamp = now();
  if (!runner) {
    runner = { id: runnerId, registeredAt: timestamp, runningJobs: 0 };
    store.runners.push(runner);
  }
  Object.assign(runner, {
    name: cleanString(name || runnerId, 200) || runnerId,
    capabilities: normalizeCapabilities(capabilities),
    workspaceIds: [...new Set((workspaceIds || []).map(value => String(value || '').trim()).filter(Boolean))].slice(0, 200),
    maxConcurrent: Math.min(16, Math.max(1, Math.trunc(Number(maxConcurrent) || 1))),
    version: cleanString(version, 100),
    platform: cleanString(platform, 100),
    arch: cleanString(arch, 100),
    labels: Object.fromEntries(Object.entries(labels || {}).slice(0, 50).map(([key, value]) => [cleanString(key, 100), cleanString(value, 300)])),
    status: 'online',
    lastHeartbeatAt: timestamp
  });
  runner.runningJobs = store.jobs.filter(job => job.runnerId === runner.id && job.status === 'running').length;
  writeStore(store);
  return publicRunner(runner);
}

export function heartbeatRunner(id, patch = {}) {
  const store = recover(readStore());
  const runner = store.runners.find(item => item.id === id);
  if (!runner) throw new Error(`Runner not found: ${id}`);
  if (patch.capabilities) runner.capabilities = normalizeCapabilities(patch.capabilities);
  if (patch.workspaceIds) runner.workspaceIds = [...new Set(patch.workspaceIds.map(value => String(value || '').trim()).filter(Boolean))];
  runner.lastHeartbeatAt = now();
  runner.status = 'online';
  runner.runningJobs = store.jobs.filter(job => job.runnerId === runner.id && job.status === 'running').length;
  writeStore(store);
  return publicRunner(runner);
}

export function listRunners() {
  return recover(readStore()).runners.map(publicRunner);
}

export function claimJob({ runnerId, leaseSeconds = 60 }) {
  const store = recover(readStore());
  if (store.drain.active) return null;
  const runner = store.runners.find(item => item.id === runnerId);
  if (!runner || runner.status !== 'online') throw new Error(`Runner is not online: ${runnerId}`);
  const running = store.jobs.filter(job => job.runnerId === runnerId && job.status === 'running').length;
  if (running >= runner.maxConcurrent) return null;
  const timestamp = Date.now();
  const candidates = store.jobs.filter(job =>
    ['queued', 'waiting_approval', 'blocked_lease'].includes(job.status) &&
    !job.cancelRequestedAt &&
    Date.parse(job.nextRunAt || 0) <= timestamp &&
    runnerMatches(job, runner)
  ).sort((a, b) => b.priority - a.priority || String(a.createdAt).localeCompare(String(b.createdAt)));
  const job = candidates[0];
  if (!job) return null;
  const fromStatus = job.status;
  job.status = 'running';
  job.runnerId = runnerId;
  job.startedAt ||= now();
  job.updatedAt = now();
  job.leaseExpiresAt = new Date(Date.now() + Math.min(300, Math.max(15, Number(leaseSeconds) || 60)) * 1000).toISOString();
  if (fromStatus !== 'waiting_approval' && fromStatus !== 'blocked_lease') job.attempts += 1;
  appendEvent(job, 'claimed', { runnerId, fromStatus, attempt: job.attempts });
  runner.runningJobs = running + 1;
  writeStore(store);
  return publicJob(job, { includeArguments: true });
}

export function renewJobLease({ id, runnerId, leaseSeconds = 60 }) {
  const store = recover(readStore());
  const job = store.jobs.find(item => item.id === id);
  if (!job || job.status !== 'running' || job.runnerId !== runnerId) return false;
  job.leaseExpiresAt = new Date(Date.now() + Math.min(300, Math.max(15, Number(leaseSeconds) || 60)) * 1000).toISOString();
  job.updatedAt = now();
  writeStore(store);
  return true;
}

function releaseRunner(store, runnerId) {
  const runner = store.runners.find(item => item.id === runnerId);
  if (runner) runner.runningJobs = Math.max(0, (runner.runningJobs || 1) - 1);
}

export function completeJob({ id, runnerId, result, artifacts = [] }) {
  const store = recover(readStore());
  const job = store.jobs.find(item => item.id === id);
  if (!job || job.status !== 'running' || job.runnerId !== runnerId) throw new Error(`Runner ${runnerId} does not own running job ${id}`);
  releaseRunner(store, runnerId);
  job.runnerId = null;
  job.leaseExpiresAt = null;
  job.updatedAt = now();
  job.finishedAt = now();
  if (job.cancelRequestedAt) {
    job.status = 'cancelled';
    appendEvent(job, 'cancelled_after_completion');
  } else {
    job.status = 'succeeded';
    job.result = clone(result);
    job.artifacts = clone(artifacts);
    appendEvent(job, 'succeeded', { artifactCount: job.artifacts.length });
  }
  writeStore(store);
  return publicJob(job, { includeResult: true });
}

export function deferJob({ id, runnerId, status, error = '', delayMs = 5000 }) {
  if (!['waiting_approval', 'blocked_lease'].includes(status)) throw new Error(`Unsupported deferred job status: ${status}`);
  const store = recover(readStore());
  const job = store.jobs.find(item => item.id === id);
  if (!job || job.status !== 'running' || job.runnerId !== runnerId) throw new Error(`Runner ${runnerId} does not own running job ${id}`);
  releaseRunner(store, runnerId);
  job.status = status;
  job.runnerId = null;
  job.leaseExpiresAt = null;
  job.error = cleanString(error, 2000);
  job.updatedAt = now();
  job.nextRunAt = new Date(Date.now() + Math.min(60000, Math.max(1000, Number(delayMs) || 5000))).toISOString();
  appendEvent(job, status, { error: job.error });
  writeStore(store);
  return publicJob(job);
}

export function failJob({ id, runnerId, error = '', retryable = true }) {
  const store = recover(readStore());
  const job = store.jobs.find(item => item.id === id);
  if (!job || job.status !== 'running' || job.runnerId !== runnerId) throw new Error(`Runner ${runnerId} does not own running job ${id}`);
  releaseRunner(store, runnerId);
  job.runnerId = null;
  job.leaseExpiresAt = null;
  job.error = cleanString(error, 4000);
  job.updatedAt = now();
  if (!job.cancelRequestedAt && retryable && job.attempts < job.maxAttempts) {
    job.status = 'queued';
    job.nextRunAt = new Date(Date.now() + Math.min(60000, 1000 * (2 ** Math.max(0, job.attempts - 1)))).toISOString();
    appendEvent(job, 'failed_attempt', { attempt: job.attempts, error: job.error, requeued: true });
  } else {
    job.status = job.cancelRequestedAt ? 'cancelled' : 'failed';
    job.finishedAt = now();
    appendEvent(job, job.status, { attempt: job.attempts, error: job.error });
  }
  writeStore(store);
  return publicJob(job);
}

export function drainStatus() {
  return clone(recover(readStore()).drain);
}

export function startDrain({ principal, reason = '' }) {
  const store = recover(readStore());
  store.drain = { active: true, startedAt: now(), startedBy: principal?.id || 'unknown', reason: cleanString(reason, 1000) };
  writeStore(store);
  return clone(store.drain);
}

export function cancelDrain({ principal }) {
  const store = recover(readStore());
  const previous = clone(store.drain);
  store.drain = { active: false, startedAt: null, startedBy: null, reason: '' };
  writeStore(store);
  return { cancelled: previous.active, previous, cancelledBy: principal?.id || 'unknown' };
}

export function jobQueueCapacityStatus() {
  const store = recover(readStore());
  return {
    activeJobs: activeJobCount(store),
    retainedJobs: store.jobs.length,
    runners: store.runners.length,
    bytes: jobStoreBytes(store),
    limits: {
      maxActiveJobs: MAX_ACTIVE_JOBS,
      maxRetainedJobs: MAX_RETAINED_JOBS,
      maxRunners: MAX_RUNNERS,
      maxBytes: MAX_JOB_STORE_BYTES
    }
  };
}

export function assertDrainAllows({ principal, capability, tool }) {
  const drain = drainStatus();
  if (!drain.active) return;
  if (String(tool || '').startsWith('deployment_drain_') || String(tool || '').startsWith('job_') && ['job_status', 'job_list', 'job_artifacts'].includes(tool)) return;
  if (principal?.source !== 'team-token') return;
  if (['write', 'execute', 'git', 'publish', 'admin'].includes(capability)) throw new Error(`DevMate is draining and is not accepting new ${capability} operations: ${drain.reason || 'maintenance in progress'}`);
}

export function clearJobsForTests() {
  writeDurableNamespace(NAMESPACE, emptyStore());
}

export const __test = {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  assertSafeArguments,
  emptyStore,
  publicJob,
  recover,
  runnerMatches,
  writeStore
};
