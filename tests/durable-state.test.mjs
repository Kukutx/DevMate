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
  assert.equal(status.version, durable.DOCUMENT_VERSION);
  assert.equal(status.supportedVersion, durable.DOCUMENT_VERSION);
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

test('recovers a previous durable document after an interrupted Windows-style replacement', () => {
  const replacement = `${durable.RUNTIME_STATE_PATH}.replace-123-456`;
  const document = {
    version: durable.DOCUMENT_VERSION,
    updatedAt: new Date().toISOString(),
    namespaces: { restored: { ok: true } }
  };
  fs.mkdirSync(path.dirname(durable.RUNTIME_STATE_PATH), { recursive: true });
  fs.rmSync(durable.RUNTIME_STATE_PATH, { force: true });
  fs.writeFileSync(replacement, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  durable.resetDurableStateForTests();
  assert.deepEqual(durable.readDurableNamespace('restored', null), { ok: true });
  assert.equal(fs.existsSync(durable.RUNTIME_STATE_PATH), true);
  assert.equal(fs.existsSync(replacement), false);
});

test('refuses to quarantine or overwrite state from a newer DevMate version', () => {
  const future = {
    version: durable.DOCUMENT_VERSION + 1,
    updatedAt: new Date().toISOString(),
    namespaces: { future: { protected: true } }
  };
  fs.mkdirSync(path.dirname(durable.RUNTIME_STATE_PATH), { recursive: true });
  fs.writeFileSync(durable.RUNTIME_STATE_PATH, `${JSON.stringify(future, null, 2)}\n`, 'utf8');
  durable.resetDurableStateForTests();
  assert.throws(() => durable.readDurableNamespace('future', null), error => {
    assert.equal(error.code, 'unsupported_state_version');
    assert.match(error.message, /newer than supported/);
    return true;
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(durable.RUNTIME_STATE_PATH, 'utf8')), future);
  const entries = fs.readdirSync(path.dirname(durable.RUNTIME_STATE_PATH));
  assert.equal(entries.some(name => name.includes('.corrupt-')), false);
});

test.after(async () => {
  try { durable.releaseGatewayInstanceLock(); } catch {}
  await fsp.rm(temp, { recursive: true, force: true });
});
