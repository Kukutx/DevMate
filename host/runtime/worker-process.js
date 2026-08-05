'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const DEFAULT_FORCE_TERMINATE_MS = 3500;

function normalizeEntry(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('A bundled Gateway entry is required');
  return path.resolve(text);
}

class WorkerProcessHandle extends EventEmitter {
  constructor(worker, {
    entry = '',
    name = 'devmate-gateway',
    forceTerminateMs = DEFAULT_FORCE_TERMINATE_MS
  } = {}) {
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
    this.forceTerminateMs = Math.max(250, Number(forceTerminateMs) || DEFAULT_FORCE_TERMINATE_MS);
    this._exited = false;
    this._terminationTimer = null;

    worker.once('online', () => {
      this.connected = true;
      this.emit('spawn');
    });
    worker.on('message', message => {
      if (message?.type === 'devmate:shutdown-complete') this.emit('shutdown-complete', message);
      this.emit('message', message);
    });
    worker.on('error', error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    worker.once('exit', code => {
      if (this._exited) return;
      this._exited = true;
      if (this._terminationTimer) clearTimeout(this._terminationTimer);
      this._terminationTimer = null;
      this.exitCode = Number(code);
      this.connected = false;
      this.killed = true;
      this.emit('exit', this.exitCode, null);
      this.emit('close', this.exitCode, null);
    });
  }

  forceTerminate() {
    Promise.resolve(this.worker.terminate()).catch(error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode != null || this.killed) return false;
    this.killed = true;
    this.connected = false;
    if (typeof this.worker.postMessage !== 'function') {
      this.forceTerminate();
      return true;
    }
    try {
      this.worker.postMessage({ type: 'devmate:shutdown', signal: String(signal || 'SIGTERM') });
      this._terminationTimer = setTimeout(() => this.forceTerminate(), this.forceTerminateMs);
      this._terminationTimer.unref?.();
    } catch (error) {
      this.lastError = error;
      this.forceTerminate();
    }
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

function createWorkerSpawn({
  WorkerImpl = Worker,
  name = 'devmate-gateway',
  forceTerminateMs = DEFAULT_FORCE_TERMINATE_MS
} = {}) {
  return function workerSpawn(_executable, args = [], options = {}) {
    const entry = normalizeEntry(args[0]);
    const worker = new WorkerImpl(entry, {
      env: options.env || process.env,
      execArgv: [],
      stdout: true,
      stderr: true,
      name
    });
    return new WorkerProcessHandle(worker, { entry, name, forceTerminateMs });
  };
}

module.exports = {
  DEFAULT_FORCE_TERMINATE_MS,
  WorkerProcessHandle,
  createWorkerSpawn,
  normalizeEntry
};
