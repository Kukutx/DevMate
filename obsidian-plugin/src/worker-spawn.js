'use strict';

const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');

class WorkerProcessHandle extends EventEmitter {
  constructor(worker) {
    super();
    this.worker = worker;
    this.stdout = worker.stdout || null;
    this.stderr = worker.stderr || null;
    this.killed = false;
    this.exitCode = null;
    this.signalCode = null;
    this.pid = Number.isInteger(worker.threadId) ? worker.threadId : null;
    this.launchMode = 'worker_threads';
    this.lastError = null;

    worker.once('online', () => this.emit('spawn'));
    worker.on('error', error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    worker.once('exit', code => {
      this.exitCode = Number(code);
      this.killed = true;
      this.emit('exit', this.exitCode, null);
    });
  }

  kill() {
    if (this.exitCode != null || this.killed) return false;
    this.killed = true;
    Promise.resolve(this.worker.terminate()).catch(error => {
      this.lastError = error;
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    return true;
  }
}

function createWorkerSpawn({ WorkerImpl = Worker } = {}) {
  return function workerSpawn(_executable, args = [], options = {}) {
    const gatewayEntry = String(args[0] || '');
    if (!gatewayEntry) throw new Error('A bundled Gateway entry is required');
    const worker = new WorkerImpl(gatewayEntry, {
      env: options.env || process.env,
      execArgv: [],
      stdout: true,
      stderr: true,
      name: 'devmate-gateway'
    });
    return new WorkerProcessHandle(worker);
  };
}

module.exports = {
  WorkerProcessHandle,
  createWorkerSpawn
};
