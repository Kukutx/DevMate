import { readConfig, redactSensitiveString } from './local-shared.mjs';
import { runWithRequestContext } from './request-context.mjs';
import { indexJobArtifacts } from './job-artifacts.mjs';
import {
  claimJob,
  completeJob,
  deferJob,
  failJob,
  heartbeatRunner,
  listRunners,
  registerRunner,
  renewJobLease
} from './job-queue.mjs';
import { incrementCounter, observeDuration, setGauge } from './observability.mjs';

const ELIGIBLE_TARGETS = new Set([
  'project_snapshot', 'show_changes', 'task_report',
  'run_smart_checks', 'run_project_script', 'run_configured_command',
  'browser_qa_run', 'browser_qa_run_saved',
  'godot_validate', 'godot_export_web', 'godot_acceptance_test',
  'godot_acceptance_run_saved', 'godot_acceptance_suite',
  'git_save'
]);

const targets = new Map();
const inflight = new Map();
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

function capabilityForTarget(name) {
  if (name.startsWith('godot_')) return ['core', 'godot'];
  if (name.startsWith('browser_') || name.startsWith('web_preview_')) return ['core', 'browser-qa'];
  return ['core'];
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

async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Job timed out after ${timeoutMs}ms`);
          error.code = 'job_timeout';
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function jobTargetEligible(name, config = {}) {
  if (!ELIGIBLE_TARGETS.has(name)) return false;
  if (name === 'git_save' && config?.allowJobGitSave === false) return false;
  return true;
}

export function jobTargetEnabled(name, config = readConfig()) {
  const enabled = new Set(config.plugins?.enabled || []);
  if (name.startsWith('godot_')) return enabled.has('devmate.godot');
  if (name.startsWith('browser_') || name.startsWith('web_preview_')) return enabled.has('devmate.browser-qa');
  return true;
}

export function registerJobTarget(name, config, handler) {
  if (!jobTargetEligible(name, readConfig()?.jobs || {})) return false;
  targets.set(name, {
    name,
    config: clone(config || {}),
    handler,
    requiredCapabilities: capabilityForTarget(name),
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
  const config = readConfig();
  return {
    id: localRunnerId(),
    name: `DevMate ${config.instanceId || 'local'}`,
    capabilities: localRunnerCapabilities(),
    workspaceIds: (config.workspaces || []).filter(item => !item.reference && item.mode !== 'readonly').map(item => item.id),
    maxConcurrent: Math.min(8, Math.max(1, Math.trunc(Number(config.runtime?.maxConcurrentJobs) || 2))),
    version: config.appVersion || '',
    labels: { deploymentMode: config.deployment?.mode || 'personal', kind: 'embedded' }
  };
}

export function refreshLocalRunner() {
  const settings = runnerSettings();
  const existing = listRunners().find(item => item.id === settings.id);
  return existing
    ? heartbeatRunner(settings.id, { capabilities: settings.capabilities, workspaceIds: settings.workspaceIds })
    : registerRunner(settings);
}

async function executeClaimedJob(job) {
  const target = jobTarget(job.tool);
  if (!target) {
    failJob({ id: job.id, runnerId: localRunnerId(), error: `Job target is not currently enabled, allowed, or registered: ${job.tool}`, retryable: true });
    return;
  }
  const started = Date.now();
  const leaseTimer = setInterval(() => {
    try { renewJobLease({ id: job.id, runnerId: localRunnerId(), leaseSeconds: 90 }); } catch {}
  }, 30000);
  leaseTimer.unref?.();
  try {
    const context = {
      requestId: `job-${job.id}`,
      principal: clone(job.requestedBy),
      startedAt: new Date().toISOString(),
      remoteAddress: 'local-job-runner',
      userAgent: 'DevMate embedded job runner',
      deploymentMode: readConfig()?.deployment?.mode || 'personal',
      jobId: job.id
    };
    const result = await withTimeout(
      runWithRequestContext(context, () => target.handler(job.arguments || {})),
      job.timeoutMs
    );
    const returnedError = resultError(result);
    if (returnedError) throw returnedError;
    const artifacts = await indexJobArtifacts(job, result);
    completeJob({ id: job.id, runnerId: localRunnerId(), result: resultSummary(result), artifacts });
    incrementCounter('devmate_jobs_total', { status: 'succeeded', tool: job.tool }, 1);
    observeDuration('devmate_job_duration_ms', { tool: job.tool }, Date.now() - started);
  } catch (error) {
    const message = String(error?.message || error);
    if (error?.code === 'approval_required') {
      deferJob({ id: job.id, runnerId: localRunnerId(), status: 'waiting_approval', error: message, delayMs: 5000 });
      incrementCounter('devmate_jobs_total', { status: 'waiting_approval', tool: job.tool }, 1);
    } else if (/requires a lease|is leased by/i.test(message)) {
      deferJob({ id: job.id, runnerId: localRunnerId(), status: 'blocked_lease', error: message, delayMs: 5000 });
      incrementCounter('devmate_jobs_total', { status: 'blocked_lease', tool: job.tool }, 1);
    } else {
      const retryable = error?.code !== 'job_timeout' && !/not allowed|requires the owner role|cannot use/i.test(message);
      failJob({ id: job.id, runnerId: localRunnerId(), error: message, retryable });
      incrementCounter('devmate_jobs_total', { status: error?.code === 'job_timeout' ? 'timed_out' : 'failed_attempt', tool: job.tool }, 1);
    }
    observeDuration('devmate_job_duration_ms', { tool: job.tool }, Date.now() - started);
  } finally {
    clearInterval(leaseTimer);
    inflight.delete(job.id);
    setGauge('devmate_jobs_inflight', {}, inflight.size);
  }
}

export async function runJobWorkerOnce() {
  if (stopping) return null;
  refreshLocalRunner();
  const settings = runnerSettings();
  if (inflight.size >= settings.maxConcurrent) return null;
  const job = claimJob({ runnerId: settings.id, leaseSeconds: 90 });
  if (!job) return null;
  const promise = executeClaimedJob(job);
  inflight.set(job.id, promise);
  setGauge('devmate_jobs_inflight', {}, inflight.size);
  void promise;
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
  const pending = Promise.allSettled([...inflight.values()]);
  let timer = null;
  try {
    await Promise.race([
      pending,
      new Promise(resolve => {
        timer = setTimeout(resolve, Math.min(60000, Math.max(0, Number(graceMs) || 15000)));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  inflight.clear();
  setGauge('devmate_jobs_inflight', {}, 0);
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

export const __test = { ELIGIBLE_TARGETS, capabilityForTarget, jobTargetEnabled, resultError, resultSummary, safeValue, targets, withTimeout };
