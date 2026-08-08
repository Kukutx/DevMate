'use strict';

const {
  applyDeploymentPatch,
  readDeploymentConfig
} = require('./shared-deployment-config.js');

function deploymentSnapshot(configFile) {
  const state = configFile ? readDeploymentConfig(configFile) : null;
  if (!state) return null;
  return {
    mode: state.deployment.mode,
    provider: state.deployment.tunnelProvider,
    publicUrl: state.deployment.publicUrl || ''
  };
}

function activeNgrokDeployment(configFile) {
  const deployment = deploymentSnapshot(configFile);
  return deployment?.provider === 'ngrok' ? deployment : null;
}

function configuredNgrokUrl(configFile, machineCandidate = '') {
  const deployment = activeNgrokDeployment(configFile);
  return deployment ? deployment.publicUrl : String(machineCandidate || '').trim();
}

function stableNgrokUrlRequired(configFile) {
  const deployment = activeNgrokDeployment(configFile);
  return deployment?.mode === 'production';
}

function writeActiveNgrokUrl(configFile, publicUrl) {
  const deployment = activeNgrokDeployment(configFile);
  if (!deployment) return { changed: false, reason: 'ngrok-not-active' };
  const config = applyDeploymentPatch(configFile, { publicUrl: String(publicUrl || '').trim() });
  return {
    changed: true,
    reason: 'shared-ngrok-updated',
    publicUrl: config.deployment.publicUrl
  };
}

module.exports = {
  activeNgrokDeployment,
  configuredNgrokUrl,
  deploymentSnapshot,
  stableNgrokUrlRequired,
  writeActiveNgrokUrl
};
