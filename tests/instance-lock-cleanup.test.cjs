'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cleanupOwnedGatewayInstanceLock,
  gatewayInstanceLockPath,
  readGatewayInstanceLock
} = require('../host/runtime/instance-lock-cleanup.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeLock(state, value) {
  const lockPath = gatewayInstanceLockPath(state);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return lockPath;
}

test('removes only a lock owned by the exited runtime', () => {
  const state = temporaryDirectory('devmate-owned-lock-');
  const lockPath = writeLock(state, {
    token: 'token',
    pid: process.pid,
    runtimeOwnerId: 'owner-a',
    instanceId: 'instance'
  });
  const result = cleanupOwnedGatewayInstanceLock({
    stateDirectory: state,
    runtimeOwnerId: 'owner-a',
    pid: process.pid
  });
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test('does not remove another runtime owner lock even under the same parent pid', () => {
  const state = temporaryDirectory('devmate-foreign-lock-');
  const lockPath = writeLock(state, {
    token: 'token',
    pid: process.pid,
    runtimeOwnerId: 'owner-b',
    instanceId: 'instance'
  });
  const result = cleanupOwnedGatewayInstanceLock({
    stateDirectory: state,
    runtimeOwnerId: 'owner-a',
    pid: process.pid
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'owner-mismatch');
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(readGatewayInstanceLock(state).runtimeOwnerId, 'owner-b');
});

test('does not remove a matching owner lock with a different process identity', () => {
  const state = temporaryDirectory('devmate-pid-lock-');
  const lockPath = writeLock(state, {
    token: 'token',
    pid: process.pid + 1,
    runtimeOwnerId: 'owner-a'
  });
  const result = cleanupOwnedGatewayInstanceLock({
    stateDirectory: state,
    runtimeOwnerId: 'owner-a',
    pid: process.pid
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, 'pid-mismatch');
  assert.equal(fs.existsSync(lockPath), true);
});
