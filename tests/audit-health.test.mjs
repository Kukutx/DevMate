import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test, drainAuditLog, withAuditLogLock } from '../gateway/audit-log-coordinator.mjs';

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-audit-health-'));
}

test('audit coordinator persists degradation until a real audit operation succeeds', async () => {
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

    await drainAuditLog(auditLog);
    assert.equal((await fsp.stat(healthFile)).isFile(), true, 'queue drain must not clear audit degradation');

    await withAuditLogLock(auditLog, async () => {
      await fsp.writeFile(auditLog, '{"ok":true}\n', 'utf8');
    });
    await assert.rejects(fsp.stat(healthFile));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a successful audit operation clears a degraded marker left by a previous process', async () => {
  const dir = await tempDir();
  try {
    const auditLog = path.join(dir, 'audit.jsonl');
    const healthFile = path.join(dir, 'audit-health.json');
    await fsp.writeFile(healthFile, '{"version":1,"status":"degraded"}\n', 'utf8');

    __test.healthKnownClean.delete(__test.auditKey(auditLog));
    await withAuditLogLock(auditLog, async () => {
      await fsp.writeFile(auditLog, '{"recovered":true}\n', 'utf8');
    });

    await assert.rejects(fsp.stat(healthFile));
    assert.equal(__test.healthKnownClean.has(__test.auditKey(auditLog)), true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
