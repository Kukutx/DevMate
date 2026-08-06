'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function childActive(child) {
  return !!child && child.exitCode == null && child.killed !== true;
}

class SharedTunnelProcess extends EventEmitter {
  constructor(runtime, launch) {
    super();
    this.runtime = runtime;
    this.launch = launch;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.delegate = null;
    this.ownerId = `${runtime.hostId}-tunnel-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.attached = false;
    this.owned = false;
    this.recordOwnerId = '';
    this.watcher = null;
    this.readyTimer = null;
    this.started = false;
    this.finished = false;
    queueMicrotask(() => this.initialize());
  }

  get pid() {
    return this.delegate?.pid || null;
  }

  async initialize() {
    if (this.killed || this.finished) return this.finish(0, 'SIGTERM');
    try {
      await this.runtime.initializeProcess(this);
      this.started = true;
      if (this.killed && this.owned) this.delegate?.kill?.('SIGTERM');
      if (this.killed && this.attached) this.finish(0, 'SIGTERM');
    } catch (error) {
      this.stderr.write(`DevMate shared tunnel start failed: ${error.message || error}\n`);
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.finish(1, null);
    }
  }

  attachOwner(child, record) {
    this.delegate = child;
    this.owned = true;
    this.attached = false;
    this.recordOwnerId = record.ownerId;
    child.stdout?.on('data', chunk => this.stdout.write(chunk));
    child.stderr?.on('data', chunk => this.stderr.write(chunk));
    child.on?.('error', error => {
      this.stderr.write(`Tunnel process error: ${error.message || error}\n`);
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    child.once?.('exit', (code, signal) => {
      this.runtime.ownerExited(this, code, signal);
      this.finish(code, signal);
    });
    this.startReadinessTimer();
  }

  attachFollower(record) {
    this.owned = false;
    this.attached = true;
    this.recordOwnerId = record.ownerId;
    this.stdout.write(`Attached to shared DevMate tunnel owned by ${record.hostId || 'another VS Code host'}.\n`);
    this.watcher = setInterval(() => {
      try {
        const current = this.runtime.store.read();
        if (!current || current.ownerId !== this.recordOwnerId) this.finish(0, null);
      } catch (error) {
        this.stderr.write(`Shared tunnel attachment ended: ${error.message || error}\n`);
        this.finish(1, null);
      }
    }, this.runtime.attachedPollMs);
    this.watcher.unref?.();
  }

  startReadinessTimer() {
    if (this.readyTimer || !this.owned || this.finished) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      void this.runtime.expirePendingOwner(this).catch(error => {
        this.stderr.write(`DevMate shared tunnel readiness cleanup failed: ${error.message || error}\n`);
      });
    }, this.runtime.readyTimeoutMs);
    this.readyTimer.unref?.();
  }

  clearReadinessTimer() {
    if (!this.readyTimer) return false;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.finished) return;
    this.finished = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    this.clearReadinessTimer();
    this.exitCode = Number.isInteger(code) ? code : null;
    this.signalCode = signal || null;
    this.stdout.end();
    this.stderr.end();
    this.runtime.processFinished(this);
    queueMicrotask(() => {
      this.emit('exit', this.exitCode, this.signalCode);
      this.emit('close', this.exitCode, this.signalCode);
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.killed || this.finished) return true;
    this.killed = true;
    if (this.owned && this.delegate) {
      try {
        return this.delegate.kill?.(signal) ?? true;
      } catch {
        return false;
      }
    }
    if (this.attached || this.started) this.finish(0, signal);
    return true;
  }

  ref() {
    this.delegate?.ref?.();
    return this;
  }

  unref() {
    this.delegate?.unref?.();
    return this;
  }
}

module.exports = {
  SharedTunnelProcess,
  childActive
};
