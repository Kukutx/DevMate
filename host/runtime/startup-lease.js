'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_STARTUP_LEASE_MS = 10000;
const DEFAULT_STARTUP_POLL_MS = 125;
const MAX_STARTUP_LOCK_BYTES = 16 * 1024;
const SAFE_LOCK_NAME = /^[a-zA-Z0-9_.-]+\.lock$/;

function nowIso() {
  return new Date().toISOString();
}

function normalizeLockName(value = 'gateway.start.lock') {
  const name = String(value || '').trim();
  if (!SAFE_LOCK_NAME.test(name) || name.includes('..')) {
    const error = new Error(`Invalid DevMate startup lease filename: ${name || '(empty)'}`);
    error.code = 'DEVMATE_INVALID_STARTUP_LEASE_NAME';
    throw error;
  }
  return name;
}

function readStartupLease(lockPath) {
  try {
    const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_STARTUP_LOCK_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { ...value, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function startupLeaseExpired(lockPath, leaseMs = DEFAULT_STARTUP_LEASE_MS, at = Date.now()) {
  const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
  if (!stat?.isFile()) return true;
  return at - stat.mtimeMs >= Math.max(1000, Number(leaseMs) || DEFAULT_STARTUP_LEASE_MS);
}

function quarantineExpiredStartupLease(lockPath, leaseMs = DEFAULT_STARTUP_LEASE_MS) {
  if (!startupLeaseExpired(lockPath, leaseMs)) return false;
  const stale = `${lockPath}.stale-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(lockPath, stale);
    try { fs.rmSync(stale, { force: true }); } catch {}
    return true;
  } catch {
    return false;
  }
}

class StartupLease {
  constructor({
    stateDirectory,
    hostId = 'host',
    lockName = 'gateway.start.lock',
    leaseMs = DEFAULT_STARTUP_LEASE_MS,
    heartbeatMs = 0
  } = {}) {
    if (!stateDirectory) throw new Error('A state directory is required for the startup lease');
    this.stateDirectory = path.resolve(stateDirectory);
    this.lockName = normalizeLockName(lockName);
    this.lockPath = path.join(this.stateDirectory, this.lockName);
    this.hostId = String(hostId || 'host');
    this.leaseMs = Math.max(2000, Number(leaseMs) || DEFAULT_STARTUP_LEASE_MS);
    this.heartbeatMs = Math.max(250, Number(heartbeatMs) || Math.floor(this.leaseMs / 4));
    this.token = crypto.randomBytes(16).toString('hex');
    this.ownerId = `${this.hostId}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    this.acquired = false;
    this.lost = false;
    this.timer = null;
  }

  payload() {
    return {
      version: 1,
      token: this.token,
      ownerId: this.ownerId,
      hostId: this.hostId,
      pid: process.pid,
      lockName: this.lockName,
      acquiredAt: nowIso(),
      leaseMs: this.leaseMs
    };
  }

  tryAcquire() {
    fs.mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.stateDirectory, 0o700); } catch {}

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, `${JSON.stringify(this.payload(), null, 2)}\n`, 'utf8');
          try { fs.fsyncSync(fd); } catch {}
        } finally {
          fs.closeSync(fd);
        }
        this.acquired = true;
        this.lost = false;
        this.startHeartbeat();
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        if (!quarantineExpiredStartupLease(this.lockPath, this.leaseMs)) return false;
      }
    }
    return false;
  }

  startHeartbeat() {
    if (this.timer || !this.acquired) return;
    this.timer = setInterval(() => {
      try { this.touch(); }
      catch { this.lost = true; }
    }, this.heartbeatMs);
    this.timer.unref?.();
  }

  touch() {
    if (!this.acquired || this.lost) return false;
    const current = readStartupLease(this.lockPath);
    if (current?.token !== this.token || current?.ownerId !== this.ownerId) {
      this.lost = true;
      return false;
    }
    const date = new Date();
    fs.utimesSync(this.lockPath, date, date);
    return true;
  }

  assertOwned() {
    if (!this.acquired || this.lost) {
      const error = new Error('DevMate startup lease was lost');
      error.code = 'DEVMATE_STARTUP_LEASE_LOST';
      throw error;
    }
    const current = readStartupLease(this.lockPath);
    if (current?.token !== this.token || current?.ownerId !== this.ownerId) {
      this.lost = true;
      const error = new Error('DevMate startup lease ownership changed unexpectedly');
      error.code = 'DEVMATE_STARTUP_LEASE_LOST';
      throw error;
    }
    return true;
  }

  release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const wasAcquired = this.acquired;
    this.acquired = false;
    if (!wasAcquired) return false;
    const current = readStartupLease(this.lockPath);
    if (current?.token !== this.token || current?.ownerId !== this.ownerId) return false;
    try {
      fs.rmSync(this.lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  snapshot() {
    const current = readStartupLease(this.lockPath);
    return {
      lockName: this.lockName,
      lockPath: this.lockPath,
      ownerId: this.ownerId,
      hostId: this.hostId,
      acquired: this.acquired,
      lost: this.lost,
      leaseMs: this.leaseMs,
      heartbeatMs: this.heartbeatMs,
      persistedOwnerId: current?.ownerId || null,
      persistedHostId: current?.hostId || null,
      persistedMtimeMs: current?.mtimeMs || null
    };
  }
}

async function waitForStartupLease(lease, {
  timeoutMs,
  pollMs = DEFAULT_STARTUP_POLL_MS,
  onWait = null
} = {}) {
  if (!(lease instanceof StartupLease)) throw new TypeError('A StartupLease instance is required');
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || lease.leaseMs * 2);
  while (Date.now() <= deadline) {
    if (lease.tryAcquire()) return lease;
    if (typeof onWait === 'function') {
      const result = await onWait();
      if (result) return result;
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(25, Number(pollMs) || DEFAULT_STARTUP_POLL_MS)));
  }
  const error = new Error(`Timed out waiting for DevMate startup lease: ${lease.lockPath}`);
  error.code = 'DEVMATE_STARTUP_LEASE_TIMEOUT';
  error.lockPath = lease.lockPath;
  throw error;
}

module.exports = {
  DEFAULT_STARTUP_LEASE_MS,
  DEFAULT_STARTUP_POLL_MS,
  MAX_STARTUP_LOCK_BYTES,
  SAFE_LOCK_NAME,
  StartupLease,
  normalizeLockName,
  quarantineExpiredStartupLease,
  readStartupLease,
  startupLeaseExpired,
  waitForStartupLease
};
