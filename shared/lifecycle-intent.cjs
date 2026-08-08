'use strict';

const path = require('node:path');
const { readJson, updateConfig } = require('./config-store.cjs');
const { LIFECYCLE_STATES, normalizeInstanceConfig } = require('./instance-config.cjs');

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

function setLifecycleIntent(configFile, desiredState, { requestedBy = '', reason = '' } = {}) {
  if (!LIFECYCLE_STATES.includes(desiredState)) throw new Error(`Unknown lifecycle state: ${String(desiredState)}`);
  const file = path.resolve(configFile);
  let snapshot = null;
  updateConfig(file, config => {
    normalizeInstanceConfig(config);
    const changed = config.lifecycle.desiredState !== desiredState;
    config.lifecycle.desiredState = desiredState;
    config.lifecycle.generation += 1;
    config.lifecycle.updatedAt = new Date().toISOString();
    config.lifecycle.requestedBy = String(requestedBy || '').slice(0, 256) || null;
    config.lifecycle.reason = String(reason || '').slice(0, 500);
    snapshot = lifecycleSnapshot(config);
    snapshot.changed = changed;
    return config;
  });
  return snapshot;
}

function lifecycleGenerationChanged(previous, current) {
  return !previous || Number(previous.generation) !== Number(current?.generation);
}

module.exports = {
  lifecycleGenerationChanged,
  lifecycleSnapshot,
  readLifecycleIntent,
  setLifecycleIntent
};