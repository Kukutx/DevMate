'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { terminateProcessTree } = require('../host/runtime/process-tree.js');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('Windows default command termination escalates from taskkill tree to forced tree and confirms exit', async () => {
  const child = fakeChild(4242);
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args: [...args] });
    const killer = new EventEmitter();
    queueMicrotask(() => {
      if (args.includes('/F')) {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      }
      killer.emit('close', 0);
    });
    return killer;
  };

  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl,
    gracefulWaitMs: 30,
    forceWaitMs: 30,
    finalWaitMs: 30
  });

  assert.equal(result.stopped, true);
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.forced, true);
  assert.deepEqual(calls[0], { command: 'taskkill', args: ['/PID', '4242', '/T'] });
  assert.deepEqual(calls[1], { command: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
});

test('POSIX default command termination targets the detached process group and escalates to SIGKILL', async () => {
  const child = fakeChild(5151);
  const signals = [];
  const killImpl = (pid, signal) => {
    signals.push({ pid, signal });
    if (signal === 'SIGKILL') {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    }
  };

  const result = await terminateProcessTree(child, {
    platform: 'linux',
    killImpl,
    gracefulWaitMs: 30,
    forceWaitMs: 30,
    finalWaitMs: 30
  });

  assert.equal(result.stopped, true);
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.forced, true);
  assert.deepEqual(signals, [
    { pid: -5151, signal: 'SIGTERM' },
    { pid: -5151, signal: 'SIGKILL' }
  ]);
});

test('process termination never reports success when process-tree exit cannot be confirmed', async () => {
  const child = fakeChild(6161);
  const spawnImpl = () => {
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  };
  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl,
    gracefulWaitMs: 25,
    forceWaitMs: 25,
    finalWaitMs: 25
  });
  assert.equal(result.stopped, false);
  assert.equal(result.exitConfirmed, false);
  assert.equal(result.reason, 'process-exit-timeout');
});
