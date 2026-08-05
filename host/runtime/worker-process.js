'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

function normalizeEntry(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('A bundled Gateway entry is required');
  return path.resolve(text);
}

class WorkerProcessHandle extends EventEmitter {
  constructor(worker, { entry = '', name = 'devmate-gateway' } = {}) {
    super();
    this.worker = worker;
    this.entry = entry;
    this.name = name;
    this.stdout = worker.stdout || null;
    this.stderr = worker.stderr || null;
    this.stdin = null;
    this.stdio = [null, this.stdout, this.stderr];
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = false;
    this.pid = Number.isInteger(worker.threadId) ? worker.threadId : null;
    this.launchMode = 'worker_threads';
    this.lastError = null;
    this._exited = false;

    worker.once('online', () => {
      this.connected = true;
      this.emit('spawn');
    });
    worker.on('error', error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    worker.once('exit', code => {
      if (this._exited) return;
      this._exited = true;
      this.exitCode = Number(code);
      this.connected = false;
      this.killed = true;
      this.emit('exit', this.exitCode, null);
      this.emit('close', this.exitCode, null);
    });
  }

  kill() {
    if (this.exitCode != null || this.killed) return false;
    this.killed = true;
    this.connected = false;
    Promise.resolve(this.worker.terminate()).catch(error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    return true;
  }

  ref() {
    this.worker.ref?.();
    return this;
  }

  unref() {
    this.worker.unref?.();
    return this;
  }
}

function createWorkerSpawn({ WorkerImpl = Worker, name = 'devmate-gateway' } = {}) {
  return function workerSpawn(_executable, args = [], options = {}) {
    const entry = normalizeEntry(args[0]);
    const worker = new WorkerImpl(entry, {
      env: options.env || process.env,
      execArgv: [],
      stdout: true,
      stderr: true,
      name
    });
    return new WorkerProcessHandle(worker, { entry, name });
  };
}

module.exports = {
  WorkerProcessHandle,
  createWorkerSpawn,
  normalizeEntry
};
