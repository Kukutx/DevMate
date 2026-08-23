import fsp from 'node:fs/promises';
import path from 'node:path';
import { clearHealthMarker, writeDegradedHealth } from './health-marker.mjs';
import { maintenanceOptions, pruneAuditLog, pruneBackups, pruneRecoveryState } from './maintenance.mjs';
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

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizePaths(paths = {}) {
  const rawStateRoot = String(paths.stateRoot || '').trim();
  if (!rawStateRoot) throw new Error('Runtime maintenance stateRoot is required');
  const stateRoot = path.resolve(rawStateRoot);
  if (stateRoot === path.parse(stateRoot).root) throw new Error('Runtime maintenance stateRoot cannot be a filesystem root');
  const backupRoot = path.resolve(String(paths.backupRoot || path.join(stateRoot, 'backups')));
  const auditLog = path.resolve(String(paths.auditLog || path.join(stateRoot, 'audit.jsonl')));
  const configDirectory = path.dirname(stateRoot);
  const configFile = path.resolve(String(paths.configFile || path.join(configDirectory, 'config.json')));
  if (!isInside(stateRoot, backupRoot)) throw new Error('Runtime maintenance backupRoot must be inside stateRoot');
  if (!isInside(stateRoot, auditLog)) throw new Error('Runtime maintenance auditLog must be inside stateRoot');
  if (path.dirname(configFile) !== configDirectory) {
    throw new Error('Runtime maintenance configFile must share the parent directory of stateRoot');
  }
  return { stateRoot, backupRoot, auditLog, configFile };
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

async function markHealthClean(file, runConfig) {
  if (healthKnownClean && isCurrent(runConfig)) return;
  await clearHealthMarker(file);
  if (isCurrent(runConfig)) healthKnownClean = true;
}

async function recordSuccess(runConfig, healthPath, result, backupMtimeMs = null) {
  if (!isCurrent(runConfig)) return;
  if (backupMtimeMs != null) lastBackupRootMtimeMs = backupMtimeMs;
  lastResult = result;
  lastError = null;
  await markHealthClean(healthPath, runConfig);
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
  if (running) {
    if (running.generation === configured.generation) return running.promise;
    await running.promise.catch(() => {});
    if (!configured) return { skipped: true, reason: 'not-configured' };
    return runRuntimeMaintenanceOnce({ force });
  }
  if (!force && !runtimeIdle()) return { skipped: true, reason: 'busy' };

  const runConfig = configured;
  const previousBackupMtimeMs = lastBackupRootMtimeMs;
  const healthPath = healthFile(runConfig.paths.stateRoot);
  let promise;
  promise = (async () => {
    const startedAt = Date.now();
    const options = currentOptions(runConfig);
    const { backupRoot, auditLog } = runConfig.paths;
    const recovery = pruneRecoveryState(runConfig.paths, startedAt);
    const recoveryDeleted = recovery.config.deleted.length + recovery.state.deleted.length;
    const [auditStat, backupRootStat] = await Promise.all([
      statOrNull(auditLog),
      statOrNull(backupRoot)
    ]);
    const auditBytes = auditStat?.size || 0;
    const auditHighWater = Math.ceil(options.maxAuditBytes * AUDIT_HIGH_WATER_RATIO);
    const auditNeedsPrune = force ? auditBytes > options.maxAuditBytes : auditBytes > auditHighWater;
    const backupMtimeMs = backupRootStat?.mtimeMs || 0;
    const backupChanged = force || previousBackupMtimeMs == null || backupMtimeMs !== previousBackupMtimeMs;

    if (!auditNeedsPrune && !backupChanged && recoveryDeleted === 0) {
      const skipped = {
        skipped: true,
        reason: 'within-bounds',
        checkedAt: now(),
        auditBytes,
        auditHighWater,
        backupMtimeMs,
        recovery
      };
      await recordSuccess(runConfig, healthPath, skipped);
      return skipped;
    }

    const result = {
      skipped: false,
      startedAt: new Date(startedAt).toISOString(),
      audit: null,
      backups: null,
      recovery
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
      await writeDegradedHealth(healthPath, error);
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
  const normalizedPaths = normalizePaths(paths);
  const normalizedIntervalMs = Math.max(5_000, Number(intervalMs) || DEFAULT_RUNTIME_MAINTENANCE_INTERVAL_MS);
  stopRuntimeMaintenance();
  configured = {
    generation,
    paths: normalizedPaths,
    options,
    getOptions,
    intervalMs: normalizedIntervalMs
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
  isInside,
  normalizePaths,
  runtimeIdle
};
