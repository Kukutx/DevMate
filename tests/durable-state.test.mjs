import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const { SUPPORTED_CONFIG_VERSION } = configStore;
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-durable-state-'));
const configPath = path.join(temp, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, instanceId: 'durable-test', permissions: { profile: 'fullAccess' } }), 'utf8');
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_RUNTIME_OWNER_ID = 'durable-owner';
process.env.DEVMATE_RUNTIME_PARENT_PID = String(process.pid);
process.env.DEVMATE_RUNTIME_LAUNCH_MODE = 'worker_threads';

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

test('accepts only the current durable state schema version', () => {
  assert.deepEqual(durable.__test.normalizeDocument({
    version: durable.DOCUMENT_VERSION,
    updatedAt: null,
    namespaces: { current: { ok: true } }
  }), {
    version: durable.DOCUMENT_VERSION,
    updatedAt: null,
    namespaces: { current: { ok: true } }
  });

  assert.throws(() => durable.__test.normalizeDocument({ namespaces: {} }), error => {
    assert.equal(error.code, 'unsupported_state_version');
    assert.equal(error.stateVersion, null);
    return true;
  });
  assert.throws(() => durable.__test.normalizeDocument({ version: durable.DOCUMENT_VERSION + 1, namespaces: {} }), error => {
    assert.equal(error.code, 'unsupported_state_version');
    return true;
  });
  for (const version of [null, '1', 0, -1, 1.5, Number.NaN]) {
    assert.throws(() => durable.__test.normalizeDocument({ version, namespaces: {} }), error => {
      assert.equal(error.code, 'invalid_state_version');
      return true;
    });
  }
});

test('rejects malformed durable document structure instead of silently dropping state', () => {
  for (const value of [null, [], 'state', { version: durable.DOCUMENT_VERSION }, { version: durable.DOCUMENT_VERSION, namespaces: [] }]) {
    assert.throws(() => durable.__test.normalizeDocument(value), error => {
      assert.equal(error.code, 'invalid_state_document');
      return true;
    });
  }
});

test('unrecoverable durable state corruption fails closed and remains intact', () => {
  const directory = path.dirname(durable.RUNTIME_STATE_PATH);
  fs.mkdirSync(directory, { recursive: true });
  const base = path.basename(durable.RUNTIME_STATE_PATH);
  const cases = [
    { payload: '{broken-json', code: 'durable_state_corrupt' },
    {
      payload: `${JSON.stringify({ version: durable.DOCUMENT_VERSION, namespaces: [] }, null, 2)}\n`,
      code: 'invalid_state_document'
    },
    {
      payload: `${JSON.stringify({ version: 0, namespaces: {} }, null, 2)}\n`,
      code: 'invalid_state_version'
    }
  ];

  for (const { payload, code } of cases) {
    for (const name of fs.readdirSync(directory)) {
      if (name.startsWith(`${base}.replace-`) || name.startsWith(`${base}.corrupt-`)) {
        fs.rmSync(path.join(directory, name), { force: true });
      }
    }
    fs.writeFileSync(durable.RUNTIME_STATE_PATH, payload, 'utf8');
    durable.resetDurableStateForTests();
    assert.throws(() => durable.readDurableNamespace('protected', null), error => error?.code === code);
    assert.equal(fs.readFileSync(durable.RUNTIME_STATE_PATH, 'utf8'), payload);
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith(`${base}.corrupt-`)), false);
  }
  fs.rmSync(durable.RUNTIME_STATE_PATH, { force: true });
  durable.resetDurableStateForTests();
});

test('derives a request-aware instance lock lease while allowing explicit test leases', () => {
  assert.equal(
    durable.configuredGatewayInstanceLeaseMs({}),
    durable.INSTANCE_LOCK_LEASE_MS
  );
  assert.equal(
    durable.configuredGatewayInstanceLeaseMs({ requestPolicy: { requestTimeoutMs: 60 * 60 * 1000 } }),
    61 * 60 * 1000
  );
  assert.equal(durable.configuredGatewayInstanceLeaseMs({}, 5000), 5000);
});

test('acquires, heartbeats, and releases an owner-aware instance lock', () => {
  const first = durable.acquireGatewayInstanceLock({ timeoutMs: 1000, leaseMs: 5000 });
  assert.equal(first.instanceId, 'durable-test');
  assert.equal(first.runtimeOwnerId, 'durable-owner');
  assert.equal(first.launchMode, 'worker_threads');
  assert.equal(first.parentPid, process.pid);
  assert.ok(Number.isInteger(first.threadId));
  assert.equal(durable.refreshGatewayInstanceLock(), true);
  const persisted = durable.readGatewayInstanceLock();
  assert.equal(persisted.runtimeOwnerId, 'durable-owner');
  assert.equal(persisted.pid, process.pid);
  assert.equal(durable.gatewayInstanceLockStale(persisted), false);
  const status = durable.durableStateStatus();
  assert.equal(status.instanceLock.runtimeOwnerId, 'durable-owner');
  assert.equal(status.instanceLock.leaseMs, 5000);
  assert.equal(durable.releaseGatewayInstanceLock(), true);
  assert.equal(fs.existsSync(durable.INSTANCE_LOCK_PATH), false);
});

test('recovers a stale instance lock whose parent process pid is still alive', () => {
  fs.mkdirSync(path.dirname(durable.INSTANCE_LOCK_PATH), { recursive: true });
  const staleAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(durable.INSTANCE_LOCK_PATH, JSON.stringify({
    version: 2,
    token: 'stale-token',
    pid: process.pid,
    parentPid: process.pid,
    threadId: 999,
    runtimeOwnerId: 'exited-worker-owner',
    launchMode: 'worker_threads',
    instanceId: 'stale',
    acquiredAt: staleAt,
    heartbeatAt: staleAt,
    leaseMs: 5000
  }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(durable.INSTANCE_LOCK_PATH, old, old);
  const before = durable.readGatewayInstanceLock();
  assert.equal(durable.gatewayInstanceLockStale(before), true);

  const recovered = durable.acquireGatewayInstanceLock({ timeoutMs: 1500, leaseMs: 5000 });
  assert.equal(recovered.instanceId, 'durable-test');
  assert.equal(recovered.runtimeOwnerId, 'durable-owner');
  assert.equal(durable.releaseGatewayInstanceLock(), true);
});

test('recovers a lock held by a dead process immediately', () => {
  fs.mkdirSync(path.dirname(durable.INSTANCE_LOCK_PATH), { recursive: true });
  fs.writeFileSync(durable.INSTANCE_LOCK_PATH, JSON.stringify({
    pid: 2147483647,
    runtimeOwnerId: 'dead-owner',
    instanceId: 'stale',
    heartbeatAt: new Date().toISOString(),
    leaseMs: 30000
  }));
  const recovered = durable.acquireGatewayInstanceLock({ timeoutMs: 1000 });
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

test('unsupported durable state is refused without quarantine or overwrite', () => {
  const directory = path.dirname(durable.RUNTIME_STATE_PATH);
  fs.mkdirSync(directory, { recursive: true });
  for (const state of [
    { updatedAt: null, namespaces: { versionless: { protected: true } } },
    { version: durable.DOCUMENT_VERSION + 1, updatedAt: null, namespaces: { future: { protected: true } } }
  ]) {
    const original = `${JSON.stringify(state, null, 2)}\n`;
    fs.writeFileSync(durable.RUNTIME_STATE_PATH, original, 'utf8');
    durable.resetDurableStateForTests();
    assert.throws(() => durable.readDurableNamespace('protected', null), error => {
      assert.equal(error.code, 'unsupported_state_version');
      return true;
    });
    assert.equal(fs.readFileSync(durable.RUNTIME_STATE_PATH, 'utf8'), original);
    const entries = fs.readdirSync(directory);
    assert.equal(entries.some(name => name.startsWith(`${path.basename(durable.RUNTIME_STATE_PATH)}.corrupt-`)), false);
  }
});

test('unsupported replacement candidates are preserved but never promoted', () => {
  const replacement = `${durable.RUNTIME_STATE_PATH}.replace-future-1`;
  const corrupt = '{broken-json';
  const future = `${JSON.stringify({
    version: durable.DOCUMENT_VERSION + 1,
    updatedAt: null,
    namespaces: { future: { protected: true } }
  }, null, 2)}\n`;
  fs.mkdirSync(path.dirname(durable.RUNTIME_STATE_PATH), { recursive: true });
  fs.writeFileSync(durable.RUNTIME_STATE_PATH, corrupt, 'utf8');
  fs.writeFileSync(replacement, future, 'utf8');
  durable.resetDurableStateForTests();
  assert.equal(durable.recoverDurableStateReplacement(), null);
  assert.equal(fs.readFileSync(durable.RUNTIME_STATE_PATH, 'utf8'), corrupt);
  assert.equal(fs.readFileSync(replacement, 'utf8'), future);
  fs.rmSync(durable.RUNTIME_STATE_PATH, { force: true });
  fs.rmSync(replacement, { force: true });
});

test.after(async () => {
  try { durable.releaseGatewayInstanceLock(); } catch {}
  durable.stopGatewayInstanceLockHeartbeat();
  delete process.env.DEVMATE_RUNTIME_OWNER_ID;
  delete process.env.DEVMATE_RUNTIME_PARENT_PID;
  delete process.env.DEVMATE_RUNTIME_LAUNCH_MODE;
  await fsp.rm(temp, { recursive: true, force: true });
});