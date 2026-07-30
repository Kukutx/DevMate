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
  'godot_project_audit', 'godot_validate', 'godot_export', 'godot_export_matrix', 'godot_export_web',
  'godot_native_test', 'godot_acceptance_test', 'godot_acceptance_run_saved', 'godot_acceptance_suite',
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
  runnerId = `embedded-${config.instanceId || process.pid}`;
  return runnerId;
}

export function refreshLocalRunner() {
  const config = readConfig();
  return registerRunner({
    id: localRunnerId(),
    name: 'Embedded DevMate Runner',
    capabilities: localRunnerCapabilities(),
    workspaceIds: (config.workspaces || []).filter(item => !item.reference && item.mode !== 'readonly').map(item => item.id),
    maxConcurrent: Math.min(8, Math.max(1, Math.trunc(Number(config.runtime?.maxConcurrentJobs) || 2))),
    version: config.appVersion || 'unknown',
    labels: { kind: 'embedded' }
  });
}

async function executeClaimed(job, runner) {
  const target = jobTarget(job.tool);
  if (!target) {
    failJob({ id: job.id, runnerId: runner.id, error: `Job target is no longer available: ${job.tool}`, retryable: false });
    return;
  }
  const principal = job.requestedBy;
  const started = Date.now();
  let leaseTimer = null;
  try {
    leaseTimer = setInterval(() => {
      try { renewJobLease({ id: job.id, runnerId: runner.id, leaseSeconds: 60 }); } catch {}
    }, 20000);
    leaseTimer.unref?.();
    const result = await runWithRequestContext({ principal, jobId: job.id }, () =>
      withTimeout(Promise.resolve(target.handler(job.arguments || {})), job.timeoutMs)
    );
    const error = resultError(result);
    if (error) throw error;
    const artifacts = await indexJobArtifacts(job, result);
    completeJob({ id: job.id, runnerId: runner.id, result: resultSummary(result), artifacts });
    incrementCounter('devmate_jobs_total', { tool: job.tool, status: 'succeeded' }, 1);
    observeDuration('devmate_job_duration_ms', { tool: job.tool, status: 'succeeded' }, Date.now() - started);
  } catch (error) {
    const message = redactSensitiveString(error?.message || error).slice(0, 8000);
    if (error?.code === 'approval_required') {
      deferJob({ id: job.id, runnerId: runner.id, status: 'waiting_approval', error: message, delayMs: 5000 });
      incrementCounter('devmate_jobs_total', { tool: job.tool, status: 'waiting_approval' }, 1);
    } else if (/requires a lease|is leased by/i.test(message)) {
      deferJob({ id: job.id, runnerId: runner.id, status: 'blocked_lease', error: message, delayMs: 5000 });
      incrementCounter('devmate_jobs_total', { tool: job.tool, status: 'blocked_lease' }, 1);
    } else {
      failJob({ id: job.id, runnerId: runner.id, error: message, retryable: error?.code !== 'job_timeout' });
      incrementCounter('devmate_jobs_total', { tool: job.tool, status: 'failed' }, 1);
      observeDuration('devmate_job_duration_ms', { tool: job.tool, status: 'failed' }, Date.now() - started);
    }
  } finally {
    if (leaseTimer) clearInterval(leaseTimer);
    inflight.delete(job.id);
    setGauge('devmate_job_inflight', { runner: runner.id }, inflight.size);
  }
}

async function tick() {
  if (stopping) return;
  const runner = refreshLocalRunner();
  while (!stopping && inflight.size < runner.maxConcurrent) {
    const job = claimJob({ runnerId: runner.id, leaseSeconds: 60 });
    if (!job) break;
    const promise = executeClaimed(job, runner);
    inflight.set(job.id, promise);
    setGauge('devmate_job_inflight', { runner: runner.id }, inflight.size);
    void promise;
  }
}

export function startJobRuntime() {
  if (workerTimer) return;
  stopping = false;
  refreshLocalRunner();
  workerTimer = setInterval(() => { void tick(); }, 1000);
  workerTimer.unref?.();
  heartbeatTimer = setInterval(() => {
    try { heartbeatRunner(localRunnerId(), { capabilities: localRunnerCapabilities(), workspaceIds: refreshLocalRunner().workspaceIds }); } catch {}
  }, 30000);
  heartbeatTimer.unref?.();
  void tick();
}

export async function shutdownJobRuntime() {
  stopping = true;
  if (workerTimer) clearInterval(workerTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  workerTimer = null;
  heartbeatTimer = null;
  await Promise.race([
    Promise.allSettled([...inflight.values()]),
    new Promise(resolve => setTimeout(resolve, 15000))
  ]);
  inflight.clear();
  runnerId = null;
  setGauge('devmate_job_inflight', { runner: 'embedded' }, 0);
}

export function jobRuntimeStatus() {
  return {
    running: !!workerTimer && !stopping,
    stopping,
    runnerId: runnerId || null,
    inflight: inflight.size,
    targetCount: jobTargetCatalog().length,
    runners: listRunners()
  };
}

export function clearJobTargetsForTests() {
  targets.clear();
}

export const __test = { ELIGIBLE_TARGETS, capabilityForTarget, resultError, resultSummary, safeValue, withTimeout };
