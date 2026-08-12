'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  StartupLease,
  normalizeLockName,
  readStartupLease,
  startupLeaseExpired,
  waitForStartupLease
} = require('../host/runtime/startup-lease.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('allows only one startup owner and verifies token ownership on release', () => {
  const state = temporaryDirectory('devmate-startup-lease-');
  const first = new StartupLease({ stateDirectory: state, hostId: 'vscode', leaseMs: 2000 });
  const second = new StartupLease({ stateDirectory: state, hostId: 'obsidian', leaseMs: 2000 });

  assert.equal(first.tryAcquire(), true);
  assert.equal(second.tryAcquire(), false);
  const persisted = readStartupLease(first.lockPath);
  assert.equal(persisted.ownerId, first.ownerId);
  assert.equal(persisted.hostId, 'vscode');
  assert.equal(persisted.lockName, 'gateway.start.lock');
  assert.equal(first.assertOwned(), true);
  assert.equal(second.release(), false);
  assert.equal(fs.existsSync(first.lockPath), true);
  assert.equal(first.release(), true);
  assert.equal(fs.existsSync(first.lockPath), false);
});

test('supports independent named startup leases without permitting path escape', () => {
  const state = temporaryDirectory('devmate-startup-named-');
  const gateway = new StartupLease({
    stateDirectory: state,
    hostId: 'vscode',
    lockName: 'gateway.start.lock',
    leaseMs: 2000
  });
  const tunnel = new StartupLease({
    stateDirectory: state,
    hostId: 'vscode',
    lockName: 'tunnel.start.lock',
    leaseMs: 2000
  });

  assert.equal(gateway.tryAcquire(), true);
  assert.equal(tunnel.tryAcquire(), true);
  assert.notEqual(gateway.lockPath, tunnel.lockPath);
  assert.equal(readStartupLease(tunnel.lockPath).lockName, 'tunnel.start.lock');
  assert.equal(normalizeLockName('custom-runtime.lock'), 'custom-runtime.lock');
  assert.throws(() => normalizeLockName('../escape.lock'), error => {
    assert.equal(error.code, 'DEVMATE_INVALID_STARTUP_LEASE_NAME');
    return true;
  });
  assert.throws(() => normalizeLockName('nested/path.lock'), /Invalid DevMate startup lease filename/);
  gateway.release();
  tunnel.release();
});

test('recovers an expired startup lease even when the recorded process is still alive', () => {
  const state = temporaryDirectory('devmate-startup-stale-');
  const first = new StartupLease({ stateDirectory: state, hostId: 'vscode', leaseMs: 2000 });
  assert.equal(first.tryAcquire(), true);
  if (first.timer) clearInterval(first.timer);
  first.timer = null;
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(first.lockPath, old, old);
  assert.equal(startupLeaseExpired(first.lockPath, 2000), true);

  const second = new StartupLease({ stateDirectory: state, hostId: 'obsidian', leaseMs: 2000 });
  assert.equal(second.tryAcquire(), true);
  assert.equal(readStartupLease(second.lockPath).ownerId, second.ownerId);
  assert.equal(first.release(), false);
  assert.equal(second.release(), true);
});

test('recovers a fresh startup lease immediately when its recorded owner process is dead', () => {
  const state = temporaryDirectory('devmate-startup-dead-owner-');
  const first = new StartupLease({ stateDirectory: state, hostId: 'vscode', leaseMs: 20000 });
  assert.equal(first.tryAcquire(), true);
  if (first.timer) clearInterval(first.timer);
  first.timer = null;

  const payload = JSON.parse(fs.readFileSync(first.lockPath, 'utf8'));
  payload.pid = 2147483647;
  fs.writeFileSync(first.lockPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  assert.equal(startupLeaseExpired(first.lockPath, 20000), true);

  const second = new StartupLease({ stateDirectory: state, hostId: 'obsidian', leaseMs: 20000 });
  assert.equal(second.tryAcquire(), true);
  assert.equal(readStartupLease(second.lockPath).ownerId, second.ownerId);
  assert.equal(first.release(), false);
  assert.equal(second.release(), true);
});

test('can converge on a runtime that becomes healthy while another host owns startup', async () => {
  const state = temporaryDirectory('devmate-startup-converge-');
  const owner = new StartupLease({ stateDirectory: state, hostId: 'vscode', leaseMs: 2000 });
  const follower = new StartupLease({ stateDirectory: state, hostId: 'obsidian', leaseMs: 2000 });
  assert.equal(owner.tryAcquire(), true);

  let checks = 0;
  const result = await waitForStartupLease(follower, {
    timeoutMs: 1500,
    pollMs: 25,
    onWait() {
      checks += 1;
      return checks >= 3 ? { attached: true, port: 8787 } : null;
    }
  });
  assert.deepEqual(result, { attached: true, port: 8787 });
  assert.equal(follower.acquired, false);
  owner.release();
});