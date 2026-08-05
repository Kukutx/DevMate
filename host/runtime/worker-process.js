'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

const DEFAULT_FORCE_TERMINATE_MS = 3500;

function normalizeEntry(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('A bundled Gateway entry is required');
  return path.resolve(text);
}

function createRuntimeOwnerId(name = 'devmate-gateway') {
  const safe = String(name || 'devmate-gateway').replace(/[^a-zA-Z0-9_.-]+/g, '-');
  return `${safe}-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

class WorkerProcessHandle extends EventEmitter {
  constructor(worker, {
    entry = '',
    name = 'devmate-gateway',
    ownerId = '',
    forceTerminateMs = DEFAULT_FORCE_TERMINATE_MS
  } = {}) {
    super();
    this.worker = worker;
    this.entry = entry;
    this.name = name;
    this.ownerId = String(ownerId || createRuntimeOwnerId(name));
    this.stdout = worker.stdout || null;
    this.stderr = worker.stderr || null;
    this.stdin = null;
    this.stdio = [null, this.stdout, this.stderr];
    this.killed = false;
    this.terminating = false;
    this.shutdownComplete = false;
    this.forceTerminated = false;
    this.exitCode = null;
    this.signalCode = null;
    this.connected = false;
    this.pid = process.pid;
    this.threadId = Number.isInteger(worker.threadId) ? worker.threadId : null;
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
      if (message?.type === 'devmate:shutdown-complete') {
        this.shutdownComplete = true;
        this.emit('shutdown-complete', message);
      }
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
      this.terminating = false;
      this.emit('exit', this.exitCode, null);
      this.emit('close', this.exitCode, null);
    });
  }

  forceTerminate() {
    if (this._exited || this.forceTerminated) return false;
    this.forceTerminated = true;
    Promise.resolve(this.worker.terminate()).catch(error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    return true;
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode != null || this.killed || this.terminating) return false;
    this.killed = true;
    this.terminating = true;
    if (typeof this.worker.postMessage !== 'function') {
      this.forceTerminate();
      return true;
    }
    try {
      this.worker.postMessage({
        type: 'devmate:shutdown',
        signal: String(signal || 'SIGTERM'),
        runtimeOwnerId: this.ownerId
      });
      this._terminationTimer = setTimeout(() => this.forceTerminate(), this.forceTerminateMs);
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

  snapshot() {
    return {
      entry: this.entry,
      name: this.name,
      ownerId: this.ownerId,
      launchMode: this.launchMode,
      pid: this.pid,
      threadId: this.threadId,
      connected: this.connected,
      killed: this.killed,
      terminating: this.terminating,
      shutdownComplete: this.shutdownComplete,
      forceTerminated: this.forceTerminated,
      exitCode: this.exitCode,
      signalCode: this.signalCode,
      lastError: this.lastError?.message || null
    };
  }
}

function createWorkerSpawn({
  WorkerImpl = Worker,
  name = 'devmate-gateway',
  forceTerminateMs = DEFAULT_FORCE_TERMINATE_MS
} = {}) {
  return function workerSpawn(_executable, args = [], options = {}) {
    const entry = normalizeEntry(args[0]);
    const ownerId = String(options.env?.DEVMATE_RUNTIME_OWNER_ID || createRuntimeOwnerId(name));
    const env = {
      ...(options.env || process.env),
      DEVMATE_RUNTIME_OWNER_ID: ownerId,
      DEVMATE_RUNTIME_PARENT_PID: String(process.pid),
      DEVMATE_RUNTIME_LAUNCH_MODE: 'worker_threads'
    };
    const worker = new WorkerImpl(entry, {
      env,
      execArgv: [],
      stdout: true,
      stderr: true,
      name
    });
    return new WorkerProcessHandle(worker, { entry, name, ownerId, forceTerminateMs });
  };
}

module.exports = {
  DEFAULT_FORCE_TERMINATE_MS,
  WorkerProcessHandle,
  createRuntimeOwnerId,
  createWorkerSpawn,
  normalizeEntry
};
