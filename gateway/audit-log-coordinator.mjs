import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const queues = new Map();
const degraded = new Set();

function auditKey(auditLog) {
  return path.resolve(String(auditLog || ''));
}

function healthFile(auditLog) {
  return path.join(path.dirname(auditKey(auditLog)), 'audit-health.json');
}

async function writeHealthError(auditLog, error) {
  const file = healthFile(auditLog);
  const payload = {
    version: 1,
    status: 'degraded',
    updatedAt: new Date().toISOString(),
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

async function clearHealthError(auditLog) {
  const key = auditKey(auditLog);
  if (!degraded.has(key)) return;
  degraded.delete(key);
  try { await fsp.rm(healthFile(auditLog), { force: true }); } catch {}
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
      degraded.add(key);
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

export function withAuditLogLock(auditLog, operation) {
  return enqueue(auditLog, operation, { trackHealth: true });
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

export const __test = { auditKey, degraded, enqueue, healthFile, queues };
