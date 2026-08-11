'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { waitForChildExit } = require('../host/runtime/process-controller.js');

function pendingChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('waitForChildExit removes exit and close listeners after confirmed exit', async () => {
  const child = pendingChild();
  const waiting = waitForChildExit(child, 1000);
  queueMicrotask(() => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  });
  assert.equal(await waiting, true);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('close'), 0);
});

test('waitForChildExit removes exit and close listeners after timeout', async () => {
  const child = pendingChild();
  assert.equal(await waitForChildExit(child, 100), false);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('close'), 0);

  assert.equal(await waitForChildExit(child, 100), false);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('close'), 0);
});
