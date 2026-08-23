'use strict';

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { StartupLease, waitForStartupLease } = require('../host/runtime/startup-lease.js');

const CONNECTION_MUTATION_LOCK_NAME = 'connection.mutation.lock';
const DEFAULT_CONNECTION_MUTATION_TIMEOUT_MS = 30000;
const mutationScope = new AsyncLocalStorage();

function mutationLeaseOptions({
  stateDirectory,
  hostId = 'desktop-connection',
  timeoutMs = DEFAULT_CONNECTION_MUTATION_TIMEOUT_MS
} = {}) {
  if (!stateDirectory) throw new Error('A shared state directory is required for connection mutation');
  const resolvedState = path.resolve(stateDirectory);
  const timeout = Math.max(2000, Number(timeoutMs) || DEFAULT_CONNECTION_MUTATION_TIMEOUT_MS);
  return {
    stateDirectory: resolvedState,
    hostId: String(hostId || 'desktop-connection'),
    timeoutMs: timeout,
    lockPath: path.join(resolvedState, CONNECTION_MUTATION_LOCK_NAME)
  };
}

async function acquireConnectionMutationLease(options = {}) {
  const normalized = mutationLeaseOptions(options);
  const lease = new StartupLease({
    stateDirectory: normalized.stateDirectory,
    hostId: normalized.hostId,
    lockName: CONNECTION_MUTATION_LOCK_NAME,
    leaseMs: normalized.timeoutMs + 10000
  });
  const acquired = await waitForStartupLease(lease, { timeoutMs: normalized.timeoutMs });
  if (!(acquired instanceof StartupLease)) {
    const error = new Error('Connection mutation lease returned an unexpected owner result');
    error.code = 'DEVMATE_CONNECTION_MUTATION_LEASE_INVALID';
    throw error;
  }
  lease.assertOwned();
  return lease;
}

function activeConnectionMutationLease(stateDirectory) {
  const current = mutationScope.getStore();
  if (!current) return null;
  const state = path.resolve(stateDirectory);
  if (current.stateDirectory !== state) return null;
  current.lease.assertOwned();
  return current.lease;
}

async function withConnectionMutationLease(options = {}, operation) {
  if (typeof operation !== 'function') throw new TypeError('Connection mutation operation must be a function');
  const normalized = mutationLeaseOptions(options);
  const existing = activeConnectionMutationLease(normalized.stateDirectory);
  if (existing) return operation(existing);

  const lease = await acquireConnectionMutationLease(normalized);
  try {
    return await mutationScope.run({ stateDirectory: normalized.stateDirectory, lease }, async () => {
      lease.assertOwned();
      const result = await operation(lease);
      lease.assertOwned();
      return result;
    });
  } finally {
    lease.release();
  }
}

module.exports = {
  CONNECTION_MUTATION_LOCK_NAME,
  DEFAULT_CONNECTION_MUTATION_TIMEOUT_MS,
  acquireConnectionMutationLease,
  activeConnectionMutationLease,
  mutationLeaseOptions,
  withConnectionMutationLease
};
