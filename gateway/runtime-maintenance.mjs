import fsp from 'node:fs/promises';
import path from 'node:path';
import { maintenanceOptions, pruneAuditLog, pruneBackups } from './maintenance.mjs';
import { sharedHttpRequestConcurrency } from './request-concurrency.mjs';
import { jobRuntimeStatus } from './job-runtime.mjs';

export const DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS = 30_000;
export const AUDIT_HIGH_WATER_RATIO = 1.25;

let timer = null;
let running = null;
let configured = null;
let lastBackupRootMtimeMs = null;
let lastResult = null;
let lastError = null;

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

function currentOptions() {
  const raw = typeof configured?.getOptions === 'function' ? configured.getOptions() : configured?.options;
  return maintenanceOptions(raw || {});
}

export function runtimeMaintenanceStatus() {
  return {
    enabled: !!timer,
    running: !!running,
    intervalMs: configured?.intervalMs || null,
    auditHighWaterRatio: AUDIT_HIGH_WATER_RATIO,
    lastBackupRootMtimeMs,
    lastResult,
    lastError
  };
}

export async function runRuntimeMaintenanceOnce({ force = false } = {}) {
  if (!configured) return { skipped: true, reason: 'not-configured' };
  if (running) return running;
  if (!force && !runtimeIdle()) return { skipped: true, reason: 'busy' };

  running = (async () => {
    const startedAt = Date.now();
    const options = currentOptions();
    const { backupRoot, auditLog } = configured.paths;
    const [auditStat, backupRootStat] = await Promise.all([
      statOrNull(auditLog),
      statOrNull(backupRoot)
    ]);
    const auditBytes = auditStat?.size || 0;
    const auditHighWater = Math.ceil(options.maxAuditBytes * AUDIT_HIGH_WATER_RATIO);
    const auditNeedsPrune = force ? auditBytes > options.maxAuditBytes : auditBytes > auditHighWater;
    const backupMtimeMs = backupRootStat?.mtimeMs || 0;
    const backupChanged = force || lastBackupRootMtimeMs == null || backupMtimeMs !== lastBackupRootMtimeMs;

    if (!auditNeedsPrune && !backupChanged) {
      const skipped = {
        skipped: true,
        reason: 'within-bounds',
        checkedAt: now(),
        auditBytes,
        auditHighWater,
        backupMtimeMs
      };
      lastResult = skipped;
      lastError = null;
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
    lastBackupRootMtimeMs = afterBackupStat?.mtimeMs || 0;
    result.completedAt = now();
    result.durationMs = Date.now() - startedAt;
    lastResult = result;
    lastError = null;
    return result;
  })().catch(error => {
    lastError = {
      at: now(),
      name: String(error?.name || 'Error'),
      code: error?.code ? String(error.code) : null,
      message: String(error?.message || error).slice(0, 2000)
    };
    throw error;
  }).finally(() => {
    running = null;
  });

  return running;
}

export function startRuntimeMaintenance({
  paths,
  options = {},
  getOptions = null,
  intervalMs = DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS
} = {}) {
  stopRuntimeMaintenance();
  configured = {
    paths: normalizePaths(paths),
    options,
    getOptions,
    intervalMs: Math.max(5_000, Number(intervalMs) || DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS)
  };
  lastBackupRootMtimeMs = null;
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
  lastBackupRootMtimeMs = null;
}

export async function drainRuntimeMaintenance() {
  if (!running) return null;
  return running.catch(() => null);
}

export const __test = {
  currentOptions,
  normalizePaths,
  runtimeIdle
};
