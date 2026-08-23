'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CONNECTION_MUTATION_LOCK_NAME,
  withConnectionMutationLease
} = require('../vscode-host/connection-mutation-lease.js');

function tempState(prefix = 'devmate-connection-mutation-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('connection mutation lease serializes independent operations for one shared state', async () => {
  const stateDirectory = tempState();
  const entered = deferred();
  const release = deferred();
  let secondEntered = false;

  try {
    const first = withConnectionMutationLease({ stateDirectory, hostId: 'first', timeoutMs: 3000 }, async lease => {
      entered.resolve(lease);
      await release.promise;
      return 'first';
    });

    await entered.promise;
    const second = withConnectionMutationLease({ stateDirectory, hostId: 'second', timeoutMs: 3000 }, async () => {
      secondEntered = true;
      return 'second';
    });

    await delay(150);
    assert.equal(secondEntered, false, 'second mutation entered before the first transaction released the lease');
    release.resolve();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.equal(secondEntered, true);
    assert.equal(fs.existsSync(path.join(stateDirectory, CONNECTION_MUTATION_LOCK_NAME)), false);
  } finally {
    release.resolve();
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('connection mutation lease is reentrant inside the same transaction scope', async () => {
  const stateDirectory = tempState();
  try {
    await withConnectionMutationLease({ stateDirectory, hostId: 'outer', timeoutMs: 3000 }, async outer => {
      await withConnectionMutationLease({ stateDirectory, hostId: 'inner', timeoutMs: 3000 }, async inner => {
        assert.equal(inner, outer);
        inner.assertOwned();
      });
      outer.assertOwned();
    });
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('connection mutation lease immediately recovers a fresh lock owned by a dead process', async () => {
  const stateDirectory = tempState();
  const lockPath = path.join(stateDirectory, CONNECTION_MUTATION_LOCK_NAME);
  fs.writeFileSync(lockPath, `${JSON.stringify({
    version: 1,
    token: 'dead-token',
    ownerId: 'dead-owner',
    hostId: 'dead-host',
    pid: 2147483647,
    lockName: CONNECTION_MUTATION_LOCK_NAME,
    acquiredAt: new Date().toISOString(),
    leaseMs: 60000
  })}\n`, { mode: 0o600 });

  try {
    let entered = false;
    await withConnectionMutationLease({ stateDirectory, hostId: 'survivor', timeoutMs: 2000 }, async lease => {
      entered = true;
      lease.assertOwned();
    });
    assert.equal(entered, true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('connection mutation leases for different shared states do not block each other', async () => {
  const leftState = tempState('devmate-connection-left-');
  const rightState = tempState('devmate-connection-right-');
  const leftEntered = deferred();
  const releaseLeft = deferred();
  let rightEntered = false;

  try {
    const left = withConnectionMutationLease({ stateDirectory: leftState, hostId: 'left', timeoutMs: 3000 }, async () => {
      leftEntered.resolve();
      await releaseLeft.promise;
    });
    await leftEntered.promise;

    await withConnectionMutationLease({ stateDirectory: rightState, hostId: 'right', timeoutMs: 3000 }, async () => {
      rightEntered = true;
    });
    assert.equal(rightEntered, true);
    releaseLeft.resolve();
    await left;
  } finally {
    releaseLeft.resolve();
    fs.rmSync(leftState, { recursive: true, force: true });
    fs.rmSync(rightState, { recursive: true, force: true });
  }
});
