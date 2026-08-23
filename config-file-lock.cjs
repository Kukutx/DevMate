'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_MS = 60000;
const MAX_LOCK_BYTES = 64 * 1024;
const held = new Map();
const sleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleeper, 0, 0, Math.max(1, Math.trunc(ms)));
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLockState(lockPath) {
  const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
  if (!stat) return { exists: false, lock: null, stat: null, valid: false };
  if (!stat.isFile() || stat.size > MAX_LOCK_BYTES) {
    return { exists: true, lock: null, stat, valid: false };
  }
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { exists: true, lock: null, stat, valid: false };
    }
    return { exists: true, lock: value, stat, valid: true };
  } catch {
    return { exists: true, lock: null, stat, valid: false };
  }
}

function readLock(lockPath) {
  return readLockState(lockPath).lock;
}

function staleLock(lock) {
  // A parsed live owner is authoritative. This synchronous lock has no
  // heartbeat that can safely justify age-based takeover. Unreadable locks are
  // handled separately from file mtime so a contender cannot steal a lock in
  // the small open('wx') -> write(JSON) initialization window.
  if (!lock || typeof lock !== 'object') return false;
  return !processAlive(lock.pid);
}

function staleUnreadableLock(state, staleMs, now = Date.now()) {
  if (!state?.exists || state.valid || !state.stat) return false;
  const age = now - Number(state.stat.mtimeMs || 0);
  return Number.isFinite(age) && age >= Math.max(1000, Number(staleMs) || DEFAULT_STALE_MS);
}

function removeStaleLock(lockPath, staleMs) {
  const state = readLockState(lockPath);
  if (!state.exists) return true;
  if (!(state.valid ? staleLock(state.lock) : staleUnreadableLock(state, staleMs))) return false;
  const quarantine = `${lockPath}.stale-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch {
    return false;
  }
  try { fs.rmSync(quarantine, { force: true }); } catch {}
  return true;
}

function acquireFileLock(file, { timeoutMs = DEFAULT_TIMEOUT_MS, staleMs = DEFAULT_STALE_MS } = {}) {
  const lockPath = `${file}.lock`;
  const existing = held.get(lockPath);
  if (existing) {
    existing.depth += 1;
    return { ...existing, reentrant: true };
  }
  const deadline = Date.now() + Math.max(100, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const token = crypto.randomBytes(16).toString('hex');
  const payload = { token, pid: process.pid, acquiredAt: new Date().toISOString(), file };
  while (Date.now() <= deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(payload)}\n`, 'utf8');
        try { fs.fsyncSync(fd); } catch {}
      } finally {
        fs.closeSync(fd);
      }
      const record = { lockPath, token, pid: process.pid, acquiredAt: payload.acquiredAt, depth: 1 };
      held.set(lockPath, record);
      return { ...record, reentrant: false };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (removeStaleLock(lockPath, Math.max(1000, Number(staleMs) || DEFAULT_STALE_MS))) continue;
      sleepSync(10);
    }
  }
  const error = new Error(`Timed out waiting for DevMate file lock: ${lockPath}`);
  error.code = 'file_lock_timeout';
  error.lockPath = lockPath;
  throw error;
}

function releaseFileLock(lock) {
  const current = held.get(lock.lockPath);
  if (!current || current.token !== lock.token) return false;
  current.depth -= 1;
  if (current.depth > 0) return true;
  held.delete(lock.lockPath);
  const persisted = readLock(lock.lockPath);
  if (persisted?.token !== lock.token || Number(persisted?.pid) !== process.pid) return false;
  try { fs.rmSync(lock.lockPath, { force: true }); return true; }
  catch { return false; }
}

function withFileLockSync(file, fn, options) {
  if (typeof fn !== 'function') throw new TypeError('File lock callback must be a function');
  const lock = acquireFileLock(file, options);
  try { return fn(lock); }
  finally { releaseFileLock(lock); }
}

function clearFileLocksForTests() {
  for (const lock of held.values()) {
    try { fs.rmSync(lock.lockPath, { force: true }); } catch {}
  }
  held.clear();
}

module.exports = {
  DEFAULT_STALE_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_LOCK_BYTES,
  acquireFileLock,
  clearFileLocksForTests,
  processAlive,
  readLock,
  readLockState,
  releaseFileLock,
  staleLock,
  staleUnreadableLock,
  withFileLockSync
};
