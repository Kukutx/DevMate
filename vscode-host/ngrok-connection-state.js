'use strict';

const {
  applyInstancePatch,
  readInstanceConfig
} = require('./shared-instance-config.js');

function connectionSnapshot(configFile) {
  const state = configFile ? readInstanceConfig(configFile) : null;
  if (!state) return null;
  return {
    provider: state.connection.provider,
    publicUrl: state.connection.publicUrl || ''
  };
}

function activeNgrokConnection(configFile) {
  const connection = connectionSnapshot(configFile);
  return connection?.provider === 'ngrok' ? connection : null;
}

function configuredNgrokUrl(configFile, machineCandidate = '') {
  const connection = activeNgrokConnection(configFile);
  return connection ? connection.publicUrl : String(machineCandidate || '').trim();
}

function writeActiveNgrokUrl(configFile, publicUrl) {
  const connection = activeNgrokConnection(configFile);
  if (!connection) return { changed: false, reason: 'ngrok-not-active' };
  const config = applyInstancePatch(configFile, { publicUrl: String(publicUrl || '').trim() });
  return {
    changed: true,
    reason: 'shared-ngrok-updated',
    publicUrl: config.connection.publicUrl
  };
}

module.exports = {
  activeNgrokConnection,
  configuredNgrokUrl,
  connectionSnapshot,
  writeActiveNgrokUrl
};