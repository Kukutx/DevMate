'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  WorkerProcessHandle,
  createRuntimeOwnerId,
  createWorkerSpawn,
  normalizeEntry
} = require('../host/runtime/worker-process.js');

class GracefulWorker extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.threadId = 44;
    this.messages = [];
    this.terminateCalls = 0;
  }
  postMessage(message) {
    this.messages.push(message);
    queueMicrotask(() => {
      this.emit('message', { type: 'devmate:shutdown-complete', runtimeOwnerId: message.runtimeOwnerId });
      this.emit('exit', 0);
    });
  }
  terminate() {
    this.terminateCalls += 1;
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
}

class StuckWorker extends EventEmitter {
  constructor(_entry, options = {}) {
    super();
    this.options = options;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.threadId = 45;
    this.messages = [];
    this.terminateCalls = 0;
  }
  postMessage(message) { this.messages.push(message); }
  terminate() {
    this.terminateCalls += 1;
    queueMicrotask(() => this.emit('exit', 1));
    return Promise.resolve(1);
  }
}

test('requests graceful Worker shutdown with its runtime owner before force termination', async () => {
  const worker = new GracefulWorker();
  const handle = new WorkerProcessHandle(worker, {
    entry: '/tmp/gateway.mjs',
    ownerId: 'owner-test',
    forceTerminateMs: 100
  });
  const completed = new Promise(resolve => handle.once('shutdown-complete', resolve));
  const exited = new Promise(resolve => handle.once('exit', resolve));
  assert.equal(handle.kill('SIGTERM'), true);
  await completed;
  await exited;
  assert.deepEqual(worker.messages, [{
    type: 'devmate:shutdown',
    signal: 'SIGTERM',
    runtimeOwnerId: 'owner-test'
  }]);
  assert.equal(worker.terminateCalls, 0);
  assert.equal(handle.exitCode, 0);
  assert.equal(handle.shutdownComplete, true);
  assert.equal(handle.forceTerminated, false);
  assert.equal(handle.threadId, 44);
  assert.equal(handle.pid, process.pid);
  assert.equal(handle.kill(), false);
});

test('force terminates an unresponsive Worker after the bounded timeout', async () => {
  const worker = new StuckWorker();
  const handle = new WorkerProcessHandle(worker, { entry: '/tmp/gateway.mjs', forceTerminateMs: 25 });
  const exited = new Promise(resolve => handle.once('exit', resolve));
  assert.equal(handle.kill(), true);
  await exited;
  assert.equal(worker.messages[0].type, 'devmate:shutdown');
  assert.equal(worker.messages[0].runtimeOwnerId, handle.ownerId);
  assert.equal(worker.terminateCalls, 1);
  assert.equal(handle.forceTerminated, true);
  assert.equal(handle.exitCode, 1);
});

test('worker spawn injects a unique owner and parent identity', async () => {
  const spawn = createWorkerSpawn({ WorkerImpl: StuckWorker, name: 'test-worker', forceTerminateMs: 25 });
  const handle = spawn(process.execPath, ['/tmp/gateway.mjs'], { env: { EXAMPLE: '1' } });
  assert.match(handle.ownerId, /^test-worker-/);
  assert.equal(handle.worker.options.env.DEVMATE_RUNTIME_OWNER_ID, handle.ownerId);
  assert.equal(handle.worker.options.env.DEVMATE_RUNTIME_PARENT_PID, String(process.pid));
  assert.equal(handle.worker.options.env.DEVMATE_RUNTIME_LAUNCH_MODE, 'worker_threads');
  const exited = new Promise(resolve => handle.once('exit', resolve));
  handle.kill();
  await exited;
});

test('normalizes valid entries and rejects empty Worker entry paths', () => {
  assert.match(createRuntimeOwnerId('gateway'), /^gateway-/);
  assert.match(normalizeEntry('./gateway.mjs'), /gateway\.mjs$/);
  assert.throws(() => normalizeEntry(''), /Gateway entry is required/);
  assert.throws(() => createWorkerSpawn()('', []), /Gateway entry is required/);
});
