'use strict';

const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { readJson, updateConfig } = require('./config-store.cjs');
const { LIFECYCLE_STATES, normalizeInstanceConfig } = require('./instance-config.cjs');

const recoveryScope = new AsyncLocalStorage();

function lifecycleSnapshot(config) {
  const normalized = normalizeInstanceConfig(config);
  return {
    desiredState: normalized.lifecycle.desiredState,
    generation: normalized.lifecycle.generation,
    updatedAt: normalized.lifecycle.updatedAt,
    requestedBy: normalized.lifecycle.requestedBy,
    reason: normalized.lifecycle.reason
  };
}

function readLifecycleIntent(configFile) {
  const file = path.resolve(configFile);
  const config = readJson(file, null, { strict: true, supportedVersion: true });
  if (!config) throw new Error(`DevMate config not found: ${file}`);
  return lifecycleSnapshot(config);
}

function lifecycleRecoveryToken(configFile) {
  const snapshot = readLifecycleIntent(configFile);
  if (snapshot.desiredState !== 'running') return null;
  return Object.freeze({
    desiredState: 'running',
    generation: Number(snapshot.generation)
  });
}

function assertLifecycleRecoveryToken(configFile, token) {
  const current = readLifecycleIntent(configFile);
  const valid = !!token &&
    token.desiredState === 'running' &&
    current.desiredState === 'running' &&
    Number(current.generation) === Number(token.generation);
  if (valid) return current;
  const error = new Error('DevMate recovery was cancelled because the shared lifecycle intent changed');
  error.code = 'DEVMATE_LIFECYCLE_RECOVERY_CANCELLED';
  error.expectedGeneration = token?.generation ?? null;
  error.currentGeneration = current.generation;
  error.currentDesiredState = current.desiredState;
  throw error;
}

function runWithLifecycleRecoveryToken(configFile, token, operation) {
  if (typeof operation !== 'function') throw new TypeError('Lifecycle recovery operation must be a function');
  const file = path.resolve(configFile);
  assertLifecycleRecoveryToken(file, token);
  return recoveryScope.run({ file, token }, operation);
}

function scopedRecovery(configFile) {
  const current = recoveryScope.getStore();
  if (!current || current.file !== path.resolve(configFile)) return null;
  return current;
}

function setLifecycleIntent(configFile, desiredState, { requestedBy = '', reason = '' } = {}) {
  if (!LIFECYCLE_STATES.includes(desiredState)) throw new Error(`Unknown lifecycle state: ${String(desiredState)}`);
  const file = path.resolve(configFile);
  const recovery = desiredState === 'running' ? scopedRecovery(file) : null;
  if (recovery) {
    const current = assertLifecycleRecoveryToken(file, recovery.token);
    return { ...current, changed: false, recoveryGuarded: true };
  }

  let snapshot = null;
  updateConfig(file, config => {
    normalizeInstanceConfig(config);
    if (config.lifecycle.desiredState === desiredState) {
      snapshot = lifecycleSnapshot(config);
      snapshot.changed = false;
      return config;
    }
    config.lifecycle.desiredState = desiredState;
    config.lifecycle.generation += 1;
    config.lifecycle.updatedAt = new Date().toISOString();
    config.lifecycle.requestedBy = String(requestedBy || '').slice(0, 256) || null;
    config.lifecycle.reason = String(reason || '').slice(0, 500);
    snapshot = lifecycleSnapshot(config);
    snapshot.changed = true;
    return config;
  });
  return snapshot;
}

function lifecycleGenerationChanged(previous, current) {
  return !previous || Number(previous.generation) !== Number(current?.generation);
}

module.exports = {
  assertLifecycleRecoveryToken,
  lifecycleGenerationChanged,
  lifecycleRecoveryToken,
  lifecycleSnapshot,
  readLifecycleIntent,
  runWithLifecycleRecoveryToken,
  setLifecycleIntent
};
