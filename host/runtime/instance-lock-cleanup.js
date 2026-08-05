'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_GATEWAY_LOCK_BYTES = 64 * 1024;

function gatewayInstanceLockPath(stateDirectory) {
  return path.join(path.resolve(stateDirectory), 'state', 'gateway.lock');
}

function readGatewayInstanceLock(stateDirectory) {
  const lockPath = gatewayInstanceLockPath(stateDirectory);
  try {
    const stat = fs.statSync(lockPath, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_GATEWAY_LOCK_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(lockPath, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, lockPath, mtimeMs: stat.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

function cleanupOwnedGatewayInstanceLock({
  stateDirectory,
  runtimeOwnerId,
  pid = process.pid
} = {}) {
  const ownerId = String(runtimeOwnerId || '').trim();
  if (!stateDirectory || !ownerId) return { removed: false, reason: 'missing-owner' };
  const current = readGatewayInstanceLock(stateDirectory);
  if (!current) return { removed: false, reason: 'not-found' };
  if (String(current.runtimeOwnerId || '') !== ownerId) {
    return { removed: false, reason: 'owner-mismatch', currentOwnerId: current.runtimeOwnerId || null };
  }
  if (Number(current.pid) !== Number(pid)) {
    return { removed: false, reason: 'pid-mismatch', currentPid: current.pid || null };
  }

  const quarantine = `${current.lockPath}.exited-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(current.lockPath, quarantine);
    try { fs.rmSync(quarantine, { force: true }); } catch {}
    return { removed: true, reason: 'owner-exited', lockPath: current.lockPath };
  } catch (error) {
    return { removed: false, reason: error.message || String(error), lockPath: current.lockPath };
  }
}

module.exports = {
  MAX_GATEWAY_LOCK_BYTES,
  cleanupOwnedGatewayInstanceLock,
  gatewayInstanceLockPath,
  readGatewayInstanceLock
};
