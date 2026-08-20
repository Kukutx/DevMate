import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withAuditLogLock } from '../gateway/audit-log-coordinator.mjs';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-audit-health-'));
}

test('audit coordinator persists degradation only after a real operation failure and clears it on recovery', async () => {
  const dir = await tempDir();
  try {
    const auditLog = path.join(dir, 'audit.jsonl');
    const healthFile = path.join(dir, 'audit-health.json');

    await assert.rejects(
      withAuditLogLock(auditLog, async () => {
        const error = new Error('simulated audit write failure');
        error.code = 'EIO';
        throw error;
      }),
      /simulated audit write failure/
    );

    const degraded = JSON.parse(await fsp.readFile(healthFile, 'utf8'));
    assert.equal(degraded.status, 'degraded');
    assert.equal(degraded.error.code, 'EIO');
    assert.match(degraded.error.message, /simulated audit write failure/);

    await withAuditLogLock(auditLog, async () => {
      await fsp.writeFile(auditLog, '{"ok":true}\n', 'utf8');
    });
    await assert.rejects(fsp.stat(healthFile));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
