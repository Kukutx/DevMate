'use strict';

const path = require('node:path');
const { readJson } = require('../shared/config-store.cjs');
const {
  deploymentMode: validateDeploymentMode,
  tunnelProvider: validateTunnelProvider
} = require('./tunnel-settings.js');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sharedDeployment(config) {
  const deployment = object(config?.deployment);
  if (!Object.keys(deployment).length) return null;
  return {
    mode: validateDeploymentMode(String(deployment.mode || 'personal').trim().toLowerCase()),
    provider: validateTunnelProvider(String(deployment.tunnelProvider || 'ngrok').trim().toLowerCase()),
    publicUrl: String(deployment.publicUrl || '').trim()
  };
}

function effectiveTunnelSettings({ sharedConfig = null, localSettings = {} } = {}) {
  const local = object(localSettings);
  const deployment = sharedDeployment(sharedConfig);
  const provider = deployment?.provider || validateTunnelProvider(String(local.provider || 'ngrok').trim().toLowerCase());
  const mode = deployment?.mode || validateDeploymentMode(String(local.deploymentMode || 'personal').trim().toLowerCase());
  const stablePublicUrl = deployment ? deployment.publicUrl : String(local.publicUrl || '').trim();
  const fallbackNgrokUrl = deployment ? deployment.publicUrl : String(local.ngrokUrl || '').trim();

  return {
    provider,
    publicUrl: provider === 'cloudflare-managed' || provider === 'external' ? stablePublicUrl : '',
    ngrokUrl: provider === 'ngrok' ? fallbackNgrokUrl : '',
    ngrokCommandPath: String(local.ngrokCommandPath || '').trim(),
    ngrokUseManagedAccount: local.ngrokUseManagedAccount !== false,
    ngrokPoolingEnabled: local.ngrokPoolingEnabled === true,
    ngrokTrafficPolicyFile: String(local.ngrokTrafficPolicyFile || '').trim(),
    cloudflareCommandPath: String(local.cloudflareCommandPath || '').trim(),
    autoRestart: local.autoRestart !== false,
    maxRestarts: local.maxRestarts,
    deploymentMode: mode
  };
}

function readSharedConfig(stateDirectory) {
  const directory = String(stateDirectory || '').trim();
  if (!directory) return null;
  return readJson(path.join(directory, 'config.json'), null, { strict: true, supportedVersion: true });
}

function settingsFromState({ stateDirectory, localSettings }) {
  return effectiveTunnelSettings({
    sharedConfig: readSharedConfig(stateDirectory),
    localSettings
  });
}

module.exports = {
  effectiveTunnelSettings,
  readSharedConfig,
  settingsFromState,
  sharedDeployment
};
