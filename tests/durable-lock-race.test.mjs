import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-durable-lock-race-'));
const configPath = path.join(temp, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({
  version: configStore.SUPPORTED_CONFIG_VERSION,
  instanceId: 'durable-race-test',
  permissions: { profile: 'fullAccess' }
}), 'utf8');
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_RUNTIME_OWNER_ID = 'durable-race-owner';

const durable = await import('../gateway/durable-state.mjs');

test('does not steal a fresh Gateway lock while its owner is still writing JSON', () => {
  fs.mkdirSync(path.dirname(durable.INSTANCE_LOCK_PATH), { recursive: true });
  fs.writeFileSync(durable.INSTANCE_LOCK_PATH, '{"token":"initializing"', 'utf8');

  assert.throws(
    () => durable.acquireGatewayInstanceLock({ timeoutMs: 1000, leaseMs: 5000 }),
    error => error?.code === 'gateway_instance_lock_timeout'
  );
  assert.equal(fs.readFileSync(durable.INSTANCE_LOCK_PATH, 'utf8'), '{"token":"initializing"');
});

test('recovers an abandoned unreadable Gateway lock after initialization grace', () => {
  durable.resetDurableStateForTests();
  fs.mkdirSync(path.dirname(durable.INSTANCE_LOCK_PATH), { recursive: true });
  fs.writeFileSync(durable.INSTANCE_LOCK_PATH, '', 'utf8');
  const old = new Date(Date.now() - durable.INSTANCE_LOCK_INITIALIZATION_GRACE_MS - 1000);
  fs.utimesSync(durable.INSTANCE_LOCK_PATH, old, old);

  const acquired = durable.acquireGatewayInstanceLock({ timeoutMs: 1000, leaseMs: 5000 });
  assert.equal(acquired.instanceId, 'durable-race-test');
  assert.equal(durable.releaseGatewayInstanceLock(), true);
});

test('older runtimes preserve future-version replacement evidence beside valid current state', () => {
  durable.resetDurableStateForTests();
  durable.writeDurableNamespace('current', { ok: true });
  const replacement = `${durable.RUNTIME_STATE_PATH}.replace-future-test`;
  fs.writeFileSync(replacement, `${JSON.stringify({
    version: durable.DOCUMENT_VERSION + 1,
    updatedAt: new Date().toISOString(),
    namespaces: { future: { protected: true } }
  }, null, 2)}\n`, 'utf8');

  durable.resetDurableStateForTests();
  assert.deepEqual(durable.readDurableNamespace('current', null), { ok: true });
  assert.equal(fs.existsSync(replacement), true);
});

test.after(async () => {
  try { durable.releaseGatewayInstanceLock(); } catch {}
  durable.stopGatewayInstanceLockHeartbeat();
  delete process.env.DEVMATE_RUNTIME_OWNER_ID;
  await fsp.rm(temp, { recursive: true, force: true });
});
