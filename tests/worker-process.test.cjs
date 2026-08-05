'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  WorkerProcessHandle,
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
      this.emit('message', { type: 'devmate:shutdown-complete' });
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
  constructor() {
    super();
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

test('requests graceful Worker shutdown before force termination', async () => {
  const worker = new GracefulWorker();
  const handle = new WorkerProcessHandle(worker, { entry: '/tmp/gateway.mjs', forceTerminateMs: 100 });
  const completed = new Promise(resolve => handle.once('shutdown-complete', resolve));
  const exited = new Promise(resolve => handle.once('exit', resolve));
  assert.equal(handle.kill('SIGTERM'), true);
  await completed;
  await exited;
  assert.deepEqual(worker.messages, [{ type: 'devmate:shutdown', signal: 'SIGTERM' }]);
  assert.equal(worker.terminateCalls, 0);
  assert.equal(handle.exitCode, 0);
  assert.equal(handle.kill(), false);
});

test('force terminates an unresponsive Worker after the bounded timeout', async () => {
  const worker = new StuckWorker();
  const handle = new WorkerProcessHandle(worker, { entry: '/tmp/gateway.mjs', forceTerminateMs: 25 });
  const exited = new Promise(resolve => handle.once('exit', resolve));
  assert.equal(handle.kill(), true);
  await exited;
  assert.equal(worker.messages[0].type, 'devmate:shutdown');
  assert.equal(worker.terminateCalls, 1);
  assert.equal(handle.exitCode, 1);
});

test('normalizes valid entries and rejects empty Worker entry paths', () => {
  assert.match(normalizeEntry('./gateway.mjs'), /gateway\.mjs$/);
  assert.throws(() => normalizeEntry(''), /Gateway entry is required/);
  assert.throws(() => createWorkerSpawn()('', []), /Gateway entry is required/);
});
