import { readConfig, redactSensitiveString } from './local-shared.mjs';
import { runWithRequestContext } from './request-context.mjs';
import { indexJobArtifacts } from './job-artifacts.mjs';
import {
  claimJob,
  completeJob,
  deferJob,
  failJob,
  getJob,
  heartbeatRunner,
  listRunners,
  registerRunner,
  renewJobLease
} from './job-queue.mjs';
import { incrementCounter, observeDuration, setGauge } from './observability.mjs';
import { builtinPlugins } from './plugins/builtins.mjs';
import { enabledSet, expandDependencies, pluginMap } from './plugins/plugin-config.mjs';
import { jobTargetNames, jobTargetPolicy } from './tool-policy.mjs';
import { normalizeInstanceConfig } from './team-access.mjs';

const targets = new Map();
const inflight = new Map();
const inflightControllers = new Map();
let workerTimer = null;
let heartbeatTimer = null;
let runnerId = null;
let stopping = false;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function safeValue(value, key = '', depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) return 'redacted';
  if (typeof value === 'string') return redactSensitiveString(value).slice(0, 10000);
  if (Array.isArray(value)) return value.slice(0, 200).map(item => safeValue(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([childKey, child]) => [childKey, safeValue(child, childKey, depth + 1)]));
  }
  return String(value).slice(0, 1000);
}

function resultSummary(result) {
  const summary = {
    isError: result?.isError === true,
    structuredContent: safeValue(result?.structuredContent ?? null),
    content: Array.isArray(result?.content)
      ? result.content.filter(item => item?.type === 'text').slice(0, 20).map(item => ({ type: 'text', text: redactSensitiveString(item.text || '').slice(0, 20000) }))
      : []
  };
  const payload = JSON.stringify(summary);
  if (Buffer.byteLength(payload, 'utf8') <= 256 * 1024) return summary;
  summary.content = [];
  summary.structuredContent = { truncated: true, preview: redactSensitiveString(payload.slice(0, 120000)) };
  return summary;
}

function resultError(result) {
  if (result?.isError !== true) return null;
  const text = Array.isArray(result.content)
    ? result.content.filter(item => item?.type === 'text').map(item => item.text).join('\n')
    : '';
  const error = new Error(redactSensitiveString(text || 'MCP tool returned an error result').slice(0, 8000));
  error.code = 'tool_error_result';
  return error;
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function withTimeout(promise, timeoutMs, onTimeout = null) {
  let timer = null;
  let timeoutError = null;
  try {
    timer = setTimeout(() => {
      timeoutError = codedError(`Job timed out after ${timeoutMs}ms`, 'job_timeout');
      try { onTimeout?.(timeoutError); } catch {}
    }, timeoutMs);
    timer.unref?.();
    try {
      const result = await promise;
      if (timeoutError) throw timeoutError;
      return result;
    } catch (error) {
      if (timeoutError) throw timeoutError;
      throw error;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function jobTargetEligible(name, config = {}) {
  return !!jobTargetPolicy(name, config);
}

export function jobTargetEnabled(name, config = readConfig()) {
  const policy = jobTargetPolicy(name, config.jobs || {});
  if (!policy) return false;
  if (!policy.pluginId) return true;
  try {
    const map = pluginMap(builtinPlugins);
    const enabled = expandDependencies(
      new Set([...enabledSet(config, builtinPlugins)].filter(id => map.has(id))),
      map
    );
    return enabled.has(policy.pluginId);
  } catch {
    return false;
  }
}

export function registerJobTarget(name, config, handler) {
  const policy = jobTargetPolicy(name, readConfig()?.jobs || {});
  if (!policy) return false;
  targets.set(name, {
    name,
    config: clone(config || {}),
    handler,
    requiredCapabilities: [...policy.requiredCapabilities],
    pluginId: policy.pluginId,
    registeredAt: new Date().toISOString()
  });
  return true;
}

export function jobTarget(name) {
  const target = targets.get(name) || null;
  const config = readConfig();
  return target && jobTargetEnabled(name, config) && jobTargetEligible(name, config.jobs || {}) ? target : null;
}

export function jobTargetCatalog() {
  const config = readConfig();
  return [...targets.values()].filter(target =>
    jobTargetEnabled(target.name, config) && jobTargetEligible(target.name, config.jobs || {})
  ).map(target => ({
    name: target.name,
    title: target.config?.title || target.name,
    description: target.config?.description || '',
    annotations: clone(target.config?.annotations || {}),
    requiredCapabilities: [...target.requiredCapabilities],
    pluginId: target.pluginId || null,
    registeredAt: target.registeredAt
  })).sort((a, b) => a.name.localeCompare(b.name));
}

function localRunnerCapabilities() {
  const output = new Set(['core']);
  for (const target of jobTargetCatalog()) for (const capability of target.requiredCapabilities) output.add(capability);
  return [...output].sort();
}

function localRunnerId() {
  if (runnerId) return runnerId;
  const config = readConfig();
  runnerId = `local-${String(config.instanceId || process.pid).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100)}`;
  return runnerId;
}

function runnerSettings() {
  const config = normalizeInstanceConfig(readConfig());
  return {
    id: localRunnerId(),
    name: `DevMate ${config.instanceId || 'local'}`,
    capabilities: localRunnerCapabilities(),
    workspaceIds: config.workspaces.filter(item => !item.reference && item.mode !== 'readonly').map(item => item.id),
    maxConcurrent: config.runtime.maxConcurrentJobs,
    version: config.appVersion || '',
    labels: { kind: 'embedded' }
  };
}

function sameValues(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ensureLocalRunnerRegistered(settings = runnerSettings()) {
  const existing = listRunners().find(item => item.id === settings.id);
  if (
    existing?.status === 'online' &&
    existing.maxConcurrent === settings.maxConcurrent &&
    sameValues(existing.capabilities, settings.capabilities) &&
    sameValues(existing.workspaceIds, settings.workspaceIds)
  ) return existing;
  return registerRunner(settings);
}

export function refreshLocalRunner() {
  const settings = runnerSettings();
  const existing = listRunners().find(item => item.id === settings.id);
  return existing
    ? heartbeatRunner(settings.id, { capabilities: settings.capabilities, workspaceIds: settings.workspaceIds })
    : registerRunner(settings);
}

async function executeClaimedJob(job, abort) {
  const target = jobTarget(job.tool);
  if (!target) {
    try {
      failJob({ id: job.id, runnerId: localRunnerId(), error: `Job target is not currently enabled, allowed, or registered: ${job.tool}`, retryable: true });
    } catch {}
    return;
  }
  const started = Date.now();
  let ownershipLost = false;
  const abortOwnership = () => {
    if (abort.signal.aborted) return;
    ownershipLost = true;
    abort.abort(codedError(`Embedded runner no longer owns job ${job.id}`, 'job_ownership_lost'));
  };
  const checkCancellation = () => {
    try {
      const current = getJob(job.id);
      if (current.status !== 'running' || current.runnerId !== localRunnerId()) {
        abortOwnership();
        return;
      }
      if (current.cancelRequestedAt && !abort.signal.aborted) {
        abort.abort(codedError(`Cancellation requested for job ${job.id}`, 'job_cancelled'));
      }
    } catch {}
  };
  const leaseTimer = setInterval(() => {
    try {
      const renewed = renewJobLease({ id: job.id, runnerId: localRunnerId(), leaseSeconds: 90 });
      if (!renewed) abortOwnership();
      else checkCancellation();
    } catch {}
  }, 30000);
  leaseTimer.unref?.();
  const cancelTimer = setInterval(checkCancellation, 2000);
  cancelTimer.unref?.();
  try {
    const config = normalizeInstanceConfig(readConfig());
    const context = {
      requestId: `job-${job.id}`,
      principal: clone(job.requestedBy),
      startedAt: new Date().toISOString(),
      remoteAddress: 'local-job-runner',
      userAgent: 'DevMate embedded job runner',
      connectionProvider: config.connection.provider,
      jobId: job.id,
      signal: abort.signal
    };
    const result = await withTimeout(
      runWithRequestContext(context, () => target.handler(job.arguments || {})),
      job.timeoutMs,
      error => { if (!abort.signal.aborted) abort.abort(error); }
    );
    if (ownershipLost) return;
    checkCancellation();
    if (ownershipLost) return;
    if (abort.signal.aborted) throw abort.signal.reason instanceof Error ? abort.signal.reason : codedError('Job cancelled', 'job_cancelled');
    const returnedError = resultError(result);
    if (returnedError) throw returnedError;
    const artifacts = await indexJobArtifacts(job, result);
    completeJob({ id: job.id, runnerId: localRunnerId(), result: resultSummary(result), artifacts });
    incrementCounter('devmate_jobs_total', { status: 'succeeded', tool: job.tool }, 1);
    observeDuration('devmate_job_duration_ms', { tool: job.tool }, Date.now() - started);
  } catch (error) {
    const message = String(error?.message || error);
    if (ownershipLost || error?.code === 'job_ownership_lost' || error?.code === 'job_runtime_shutdown') {
      incrementCounter('devmate_jobs_total', { status: ownershipLost ? 'ownership_lost' : 'interrupted', tool: job.tool }, 1);
    } else {
      try {
        if (error?.code === 'approval_required') {
          deferJob({ id: job.id, runnerId: localRunnerId(), status: 'waiting_approval', error: message, delayMs: 5000 });
          incrementCounter('devmate_jobs_total', { status: 'waiting_approval', tool: job.tool }, 1);
        } else if (/requires a lease|is leased by/i.test(message)) {
          deferJob({ id: job.id, runnerId: localRunnerId(), status: 'blocked_lease', error: message, delayMs: 5000 });
          incrementCounter('devmate_jobs_total', { status: 'blocked_lease', tool: job.tool }, 1);
        } else {
          const retryable = !['job_timeout', 'job_cancelled'].includes(error?.code) && !/not allowed|requires the owner role|cannot use/i.test(message);
          failJob({ id: job.id, runnerId: localRunnerId(), error: message, retryable });
          const status = error?.code === 'job_timeout' ? 'timed_out' : error?.code === 'job_cancelled' ? 'cancelled' : 'failed_attempt';
          incrementCounter('devmate_jobs_total', { status, tool: job.tool }, 1);
        }
      } catch (reportError) {
        if (/does not own running job/i.test(String(reportError?.message || reportError))) ownershipLost = true;
      }
    }
    observeDuration('devmate_job_duration_ms', { tool: job.tool }, Date.now() - started);
  } finally {
    clearInterval(leaseTimer);
    clearInterval(cancelTimer);
  }
}

export async function runJobWorkerOnce() {
  if (stopping) return null;
  const settings = runnerSettings();
  ensureLocalRunnerRegistered(settings);
  if (inflight.size >= settings.maxConcurrent) return null;
  const job = claimJob({ runnerId: settings.id, leaseSeconds: 90 });
  if (!job) return null;
  const abort = new AbortController();
  let tracked;
  tracked = executeClaimedJob(job, abort).finally(() => {
    if (inflight.get(job.id) === tracked) inflight.delete(job.id);
    if (inflightControllers.get(job.id) === abort) inflightControllers.delete(job.id);
    setGauge('devmate_jobs_inflight', {}, inflight.size);
  });
  inflight.set(job.id, tracked);
  inflightControllers.set(job.id, abort);
  setGauge('devmate_jobs_inflight', {}, inflight.size);
  void tracked.catch(() => {});
  return job;
}

export function startJobRuntime() {
  if (workerTimer) return;
  stopping = false;
  refreshLocalRunner();
  workerTimer = setInterval(() => {
    const max = runnerSettings().maxConcurrent;
    for (let index = inflight.size; index < max; index += 1) void runJobWorkerOnce();
  }, 1000);
  workerTimer.unref?.();
  heartbeatTimer = setInterval(() => {
    try { refreshLocalRunner(); } catch {}
  }, 30000);
  heartbeatTimer.unref?.();
}

export async function shutdownJobRuntime({ graceMs = 15000 } = {}) {
  stopping = true;
  if (workerTimer) clearInterval(workerTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  workerTimer = null;
  heartbeatTimer = null;
  const shutdownError = codedError('Embedded Job runtime is shutting down', 'job_runtime_shutdown');
  for (const abort of inflightControllers.values()) {
    if (!abort.signal.aborted) abort.abort(shutdownError);
  }
  const pending = Promise.allSettled([...inflight.values()]);
  let timer = null;
  let drained = false;
  try {
    await Promise.race([
      pending.then(() => { drained = true; }),
      new Promise(resolve => {
        timer = setTimeout(resolve, Math.min(60000, Math.max(0, Number(graceMs) || 15000)));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  setGauge('devmate_jobs_inflight', {}, inflight.size);
  return { drained, inflight: [...inflight.keys()] };
}

export function jobRuntimeStatus() {
  return {
    started: !!workerTimer,
    stopping,
    runnerId: localRunnerId(),
    inflight: [...inflight.keys()],
    targets: jobTargetCatalog()
  };
}

export const __test = {
  codedError,
  inflight,
  inflightControllers,
  jobTargetNames,
  resultError,
  resultSummary,
  safeValue,
  targets,
  withTimeout
};
