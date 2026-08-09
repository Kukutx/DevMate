import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditLogQueueSize, withAuditLogLock } from '../gateway/audit-log-coordinator.mjs';

test('serializes operations for the same audit log while preserving order', async () => {
  const file = path.join(os.tmpdir(), `devmate-audit-lock-${process.pid}.jsonl`);
  const order = [];
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const first = withAuditLogLock(file, async () => {
    order.push('first-start');
    await firstGate;
    order.push('first-end');
  });
  const second = withAuditLogLock(file, async () => {
    order.push('second-start');
    order.push('second-end');
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
  assert.equal(auditLogQueueSize(), 0);
});
