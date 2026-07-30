import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-durable-state-'));
const configPath = path.join(temp, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({ instanceId: 'durable-test', permissions: { profile: 'fullAccess' } }), 'utf8');
process.env.DEVMATE_CONFIG = configPath;

const durable = await import('../gateway/durable-state.mjs');

test('persists namespaced runtime state atomically', () => {
  durable.writeDurableNamespace('example', { count: 3, values: ['a', 'b'] });
  durable.resetDurableStateForTests();
  assert.deepEqual(durable.readDurableNamespace('example', null), { count: 3, values: ['a', 'b'] });
  const status = durable.durableStateStatus();
  assert.equal(status.enabled, true);
  assert.ok(status.namespaces.includes('example'));
  assert.ok(status.bytes > 0);
});

test('acquires, releases, and recovers a stale instance lock', () => {
  const first = durable.acquireGatewayInstanceLock();
  assert.equal(first.instanceId, 'durable-test');
  assert.equal(durable.releaseGatewayInstanceLock(), true);

  fs.mkdirSync(path.dirname(durable.INSTANCE_LOCK_PATH), { recursive: true });
  fs.writeFileSync(durable.INSTANCE_LOCK_PATH, JSON.stringify({ pid: 2147483647, instanceId: 'stale' }));
  const recovered = durable.acquireGatewayInstanceLock();
  assert.equal(recovered.instanceId, 'durable-test');
  assert.equal(durable.releaseGatewayInstanceLock(), true);
});

test.after(async () => {
  try { durable.releaseGatewayInstanceLock(); } catch {}
  await fsp.rm(temp, { recursive: true, force: true });
});
