'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { OperationCoordinator } = require('../host/runtime/operation-coordinator.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('serializes operations in submission order', async () => {
  const coordinator = new OperationCoordinator({ name: 'runtime' });
  const gate = deferred();
  const events = [];

  const first = coordinator.run('start', async () => {
    events.push('start:begin');
    await gate.promise;
    events.push('start:end');
    return 'started';
  });
  const second = coordinator.run('stop', async () => {
    events.push('stop');
    return 'stopped';
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['start:begin']);
  assert.equal(coordinator.snapshot().current.name, 'start');
  assert.equal(coordinator.snapshot().queued, 1);

  gate.resolve();
  assert.equal(await first, 'started');
  assert.equal(await second, 'stopped');
  assert.deepEqual(events, ['start:begin', 'start:end', 'stop']);
  await coordinator.idle();
  assert.equal(coordinator.snapshot().current, null);
  assert.equal(coordinator.snapshot().queued, 0);
});

test('continues the queue after a rejected operation', async () => {
  const coordinator = new OperationCoordinator();
  const first = coordinator.run('broken', async () => {
    throw new Error('synthetic failure');
  });
  const second = coordinator.run('recovery', async () => 'ok');

  await assert.rejects(first, /synthetic failure/);
  assert.equal(await second, 'ok');
  await coordinator.idle();
});
