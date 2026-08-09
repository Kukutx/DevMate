'use strict';

const path = require('node:path');
const { readJson } = require('../shared/config-store.cjs');
const { normalizeInstanceConfig } = require('../shared/instance-config.cjs');
const { tunnelProvider: validateTunnelProvider } = require('./tunnel-settings.js');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function missingSharedConfigError(file = '') {
  const error = new Error('DevMate shared config is required before resolving public connection settings');
  error.code = 'DEVMATE_SHARED_CONFIG_MISSING';
  if (file) error.configFile = file;
  return error;
}

function sharedConnection(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw missingSharedConfigError();
  const normalized = normalizeInstanceConfig(config);
  return {
    provider: validateTunnelProvider(String(normalized.connection.provider || 'ngrok').trim().toLowerCase()),
    publicUrl: String(normalized.connection.publicUrl || '').trim()
  };
}

function effectiveTunnelSettings({ sharedConfig, localSettings = {} } = {}) {
  const local = object(localSettings);
  const connection = sharedConnection(sharedConfig);
  const provider = connection.provider;
  const stablePublicUrl = connection.publicUrl;

  return {
    provider,
    publicUrl: provider === 'cloudflare-managed' || provider === 'external' ? stablePublicUrl : '',
    ngrokUrl: provider === 'ngrok' ? stablePublicUrl : '',
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
  if (!directory) throw missingSharedConfigError();
  const file = path.join(directory, 'config.json');
  const config = readJson(file, null, { strict: true, supportedVersion: true });
  if (!config) throw missingSharedConfigError(file);
  return normalizeInstanceConfig(config);
}

function settingsFromState({ stateDirectory, localSettings }) {
  return effectiveTunnelSettings({
    sharedConfig: readSharedConfig(stateDirectory),
    localSettings
  });
}

module.exports = {
  effectiveTunnelSettings,
  missingSharedConfigError,
  readSharedConfig,
  settingsFromState,
  sharedConnection
};
