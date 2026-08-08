'use strict';

const path = require('node:path');
const { readJson } = require('../shared/config-store.cjs');
const { normalizeInstanceConfig } = require('../shared/instance-config.cjs');
const { tunnelProvider: validateTunnelProvider } = require('./tunnel-settings.js');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sharedConnection(config) {
  if (!config || typeof config !== 'object') return null;
  const normalized = normalizeInstanceConfig(config);
  return {
    provider: validateTunnelProvider(String(normalized.connection.provider || 'ngrok').trim().toLowerCase()),
    publicUrl: String(normalized.connection.publicUrl || '').trim()
  };
}

function effectiveTunnelSettings({ sharedConfig = null, localSettings = {} } = {}) {
  const local = object(localSettings);
  const connection = sharedConfig ? sharedConnection(sharedConfig) : null;
  const provider = connection?.provider || validateTunnelProvider(String(local.provider || 'ngrok').trim().toLowerCase());
  const stablePublicUrl = connection?.publicUrl ?? String(local.publicUrl || '').trim();
  const fallbackNgrokUrl = connection?.publicUrl ?? String(local.ngrokUrl || '').trim();

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
    maxRestarts: local.maxRestarts
  };
}

function readSharedConfig(stateDirectory) {
  const directory = String(stateDirectory || '').trim();
  if (!directory) return null;
  const config = readJson(path.join(directory, 'config.json'), null, { strict: true, supportedVersion: true });
  return config ? normalizeInstanceConfig(config) : null;
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
  sharedConnection
};