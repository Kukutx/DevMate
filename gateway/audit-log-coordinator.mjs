import path from 'node:path';

const queues = new Map();

export async function withAuditLogLock(auditLog, operation) {
  if (typeof operation !== 'function') throw new TypeError('Audit log operation must be a function');
  const key = path.resolve(String(auditLog || ''));
  const previous = queues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(operation);
  queues.set(key, run);
  try {
    return await run;
  } finally {
    if (queues.get(key) === run) queues.delete(key);
  }
}

export function drainAuditLog(auditLog) {
  return withAuditLogLock(auditLog, async () => {});
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

export const __test = { queues };
