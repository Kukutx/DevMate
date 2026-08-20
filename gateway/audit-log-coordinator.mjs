import path from 'node:path';
import { clearHealthMarker, writeDegradedHealth } from './health-marker.mjs';

const queues = new Map();
const healthKnownClean = new Set();

function auditKey(auditLog) {
  const value = String(auditLog || '').trim();
  if (!value) throw new Error('Audit log path is required');
  return path.resolve(value);
}

function healthFile(auditLog) {
  return path.join(path.dirname(auditKey(auditLog)), 'audit-health.json');
}

async function writeHealthError(auditLog, error) {
  const key = auditKey(auditLog);
  healthKnownClean.delete(key);
  await writeDegradedHealth(healthFile(auditLog), error);
}

async function clearHealthError(auditLog) {
  const key = auditKey(auditLog);
  if (healthKnownClean.has(key)) return;
  await clearHealthMarker(healthFile(auditLog));
  healthKnownClean.add(key);
}

async function enqueue(auditLog, operation, { trackHealth = true } = {}) {
  if (typeof operation !== 'function') throw new TypeError('Audit log operation must be a function');
  const key = auditKey(auditLog);
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    if (!trackHealth) return operation();
    try {
      const result = await operation();
      await clearHealthError(auditLog);
      return result;
    } catch (error) {
      await writeHealthError(auditLog, error);
      throw error;
    }
  });
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

export function withAuditLogLock(auditLog, operation, { trackHealth = true } = {}) {
  return enqueue(auditLog, operation, { trackHealth });
}

export function drainAuditLog(auditLog) {
  return enqueue(auditLog, async () => {}, { trackHealth: false });
}

export async function drainAllAuditLogs() {
  for (;;) {
    const active = [...queues.values()];
    if (active.length) {
      await Promise.allSettled(active);
      continue;
    }
    await new Promise(resolve => setImmediate(resolve));
    if (!queues.size) return;
  }
}

export function auditLogQueueSize() {
  return queues.size;
}

export const __test = { auditKey, enqueue, healthFile, healthKnownClean, queues };
