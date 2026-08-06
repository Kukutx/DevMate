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
    this.recovering = false;
    this.recoveryCount = 0;
    queueMicrotask(() => this.initialize());
  }

  get pid() {
    return this.delegate?.pid || null;
  }

  reportStartFailure(error, prefix = 'DevMate shared tunnel start failed') {
    this.stderr.write(`${prefix}: ${error.message || error}\n`);
    if (this.listenerCount('error') > 0) this.emit('error', error);
    this.finish(1, null);
  }

  async initialize() {
    if (this.killed || this.finished) return this.finish(0, 'SIGTERM');
    try {
      await this.runtime.initializeProcess(this);
      this.started = true;
      if (this.killed && this.owned) this.delegate?.kill?.('SIGTERM');
      if (this.killed && this.attached) this.finish(0, 'SIGTERM');
    } catch (error) {
      this.reportStartFailure(error);
    }
  }

  attachOwner(child, record) {
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    this.recovering = false;
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
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    this.delegate = null;
    this.owned = false;
    this.attached = true;
    this.recovering = false;
    this.recordOwnerId = record.ownerId;
    this.stdout.write(`Attached to shared DevMate tunnel owned by ${record.hostId || 'another VS Code host'}.\n`);
    this.watcher = setInterval(() => this.checkAttachment(), this.runtime.attachedPollMs);
    this.watcher.unref?.();
  }

  checkAttachment() {
    if (this.finished || this.killed || this.recovering) return;
    try {
      const current = this.runtime.store.read();
      if (current?.ownerId === this.recordOwnerId) return;
      if (current) {
        if (!this.runtime.recordMatches(current, this.launch.match)) {
          throw this.runtime.conflictError(current, this.launch.match);
        }
        this.recordOwnerId = current.ownerId;
        this.stdout.write(`Reattached to replacement DevMate tunnel owner ${current.hostId || current.ownerId}.\n`);
        return;
      }
      this.recoverAttachment();
    } catch (error) {
      this.reportStartFailure(error, 'Shared tunnel attachment ended');
    }
  }

  recoverAttachment() {
    if (this.finished || this.killed || this.recovering) return;
    if (this.recoveryCount >= 1) {
      const error = new Error('Shared tunnel owner disappeared again after follower recovery');
      error.code = 'DEVMATE_TUNNEL_FOLLOWER_RECOVERY_EXHAUSTED';
      this.reportStartFailure(error, 'Shared tunnel attachment ended');
      return;
    }
    this.recoveryCount += 1;
    this.recovering = true;
    this.attached = false;
    this.recordOwnerId = '';
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    this.stdout.write('Shared tunnel owner disappeared before readiness; retrying ownership once.\n');
    void this.runtime.initializeProcess(this).then(() => {
      this.recovering = false;
      this.started = true;
      if (this.killed && this.owned) this.delegate?.kill?.('SIGTERM');
      if (this.killed && this.attached) this.finish(0, 'SIGTERM');
    }).catch(error => this.reportStartFailure(error, 'Shared tunnel follower recovery failed'));
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
    this.recovering = false;
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
    if (this.attached || this.recovering || this.started) this.finish(0, signal);
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
