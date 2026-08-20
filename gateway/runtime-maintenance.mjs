import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { maintenanceOptions, pruneAuditLog, pruneBackups } from './maintenance.mjs';
import { sharedHttpRequestConcurrency } from './request-concurrency.mjs';
import { jobRuntimeStatus } from './job-runtime.mjs';

export const DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS = 30_000;
export const AUDIT_HIGH_WATER_RATIO = 1.25;

let timer = null;
let running = null;
let configured = null;
let generation = 0;
let lastBackupRootMtimeMs = null;
let lastResult = null;
let lastError = null;
let healthKnownClean = false;

function now() {
  return new Date().toISOString();
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch { return null; }
}

function runtimeIdle() {
  if (sharedHttpRequestConcurrency.global() !== 0) return false;
  try {
    return jobRuntimeStatus().inflight.length === 0;
  } catch {
    return false;
  }
}

function normalizePaths(paths = {}) {
  const stateRoot = path.resolve(String(paths.stateRoot || ''));
  const backupRoot = path.resolve(String(paths.backupRoot || path.join(stateRoot, 'backups')));
  const auditLog = path.resolve(String(paths.auditLog || path.join(stateRoot, 'audit.jsonl')));
  return { stateRoot, backupRoot, auditLog };
}

function currentOptions(runConfig = configured) {
  const raw = typeof runConfig?.getOptions === 'function' ? runConfig.getOptions() : runConfig?.options;
  return maintenanceOptions(raw || {});
}

function healthFile(stateRoot) {
  return path.join(stateRoot, 'runtime-maintenance.json');
}

function isCurrent(runConfig) {
  return !!configured && configured.generation === runConfig?.generation;
}

async function persistHealthError(file, error) {
  const payload = {
    version: 1,
    status: 'degraded',
    updatedAt: now(),
    error: {
      name: String(error?.name || 'Error').slice(0, 120),
      code: error?.code ? String(error.code).slice(0, 120) : null,
      message: String(error?.message || error).slice(0, 2000)
    }
  };
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try { await fsp.chmod(tmp, 0o600); } catch {}
      await fsp.rename(tmp, file);
      try { await fsp.chmod(file, 0o600); } catch {}
    } finally {
      try { await fsp.rm(tmp, { force: true }); } catch {}
    }
  } catch {}
}

async function markHealthClean(file) {
  if (healthKnownClean) return;
  try { await fsp.rm(file, { force: true }); } catch {}
  healthKnownClean = true;
}

function recordSuccess(runConfig, healthPath, result, backupMtimeMs = null) {
  if (!isCurrent(runConfig)) return Promise.resolve();
  if (backupMtimeMs != null) lastBackupRootMtimeMs = backupMtimeMs;
  lastResult = result;
  lastError = null;
  return markHealthClean(healthPath);
}

export function runtimeMaintenanceStatus() {
  return {
    enabled: !!timer,
    running: !!running,
    generation: configured?.generation || generation,
    runningGeneration: running?.generation || null,
    intervalMs: configured?.intervalMs || null,
    auditHighWaterRatio: AUDIT_HIGH_WATER_RATIO,
    lastBackupRootMtimeMs,
    lastResult,
    lastError
  };
}

export async function runRuntimeMaintenanceOnce({ force = false } = {}) {
  if (!configured) return { skipped: true, reason: 'not-configured' };
  if (running) return running.promise;
  if (!force && !runtimeIdle()) return { skipped: true, reason: 'busy' };

  const runConfig = configured;
  const previousBackupMtimeMs = lastBackupRootMtimeMs;
  const healthPath = healthFile(runConfig.paths.stateRoot);
  let promise;
  promise = (async () => {
    const startedAt = Date.now();
    const options = currentOptions(runConfig);
    const { backupRoot, auditLog } = runConfig.paths;
    const [auditStat, backupRootStat] = await Promise.all([
      statOrNull(auditLog),
      statOrNull(backupRoot)
    ]);
    const auditBytes = auditStat?.size || 0;
    const auditHighWater = Math.ceil(options.maxAuditBytes * AUDIT_HIGH_WATER_RATIO);
    const auditNeedsPrune = force ? auditBytes > options.maxAuditBytes : auditBytes > auditHighWater;
    const backupMtimeMs = backupRootStat?.mtimeMs || 0;
    const backupChanged = force || previousBackupMtimeMs == null || backupMtimeMs !== previousBackupMtimeMs;

    if (!auditNeedsPrune && !backupChanged) {
      const skipped = {
        skipped: true,
        reason: 'within-bounds',
        checkedAt: now(),
        auditBytes,
        auditHighWater,
        backupMtimeMs
      };
      await recordSuccess(runConfig, healthPath, skipped);
      return skipped;
    }

    const result = {
      skipped: false,
      startedAt: new Date(startedAt).toISOString(),
      audit: null,
      backups: null
    };
    if (auditNeedsPrune) result.audit = await pruneAuditLog(auditLog, options);
    if (backupChanged) result.backups = await pruneBackups(backupRoot, options);
    const afterBackupStat = await statOrNull(backupRoot);
    const afterBackupMtimeMs = afterBackupStat?.mtimeMs || 0;
    result.completedAt = now();
    result.durationMs = Date.now() - startedAt;
    await recordSuccess(runConfig, healthPath, result, afterBackupMtimeMs);
    return result;
  })().catch(async error => {
    if (isCurrent(runConfig)) {
      healthKnownClean = false;
      lastError = {
        at: now(),
        name: String(error?.name || 'Error'),
        code: error?.code ? String(error.code) : null,
        message: String(error?.message || error).slice(0, 2000)
      };
      await persistHealthError(healthPath, error);
    }
    throw error;
  }).finally(() => {
    if (running?.promise === promise) running = null;
  });

  running = { generation: runConfig.generation, promise };
  return promise;
}

export function startRuntimeMaintenance({
  paths,
  options = {},
  getOptions = null,
  intervalMs = DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS
} = {}) {
  stopRuntimeMaintenance();
  configured = {
    generation,
    paths: normalizePaths(paths),
    options,
    getOptions,
    intervalMs: Math.max(5_000, Number(intervalMs) || DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS)
  };
  lastBackupRootMtimeMs = null;
  lastResult = null;
  lastError = null;
  healthKnownClean = false;
  timer = setInterval(() => {
    void runRuntimeMaintenanceOnce().catch(() => {});
  }, configured.intervalMs);
  timer.unref?.();
  return runtimeMaintenanceStatus();
}

export function stopRuntimeMaintenance() {
  if (timer) clearInterval(timer);
  timer = null;
  configured = null;
  generation += 1;
  lastBackupRootMtimeMs = null;
  healthKnownClean = false;
}

export async function drainRuntimeMaintenance() {
  if (!running) return null;
  return running.promise.catch(() => null);
}

export const __test = {
  currentOptions,
  healthFile,
  isCurrent,
  normalizePaths,
  runtimeIdle
};
