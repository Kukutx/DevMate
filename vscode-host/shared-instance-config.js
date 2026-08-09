'use strict';

const { readJson, updateConfig } = require('../shared/config-store.cjs');
const { normalizeInstanceConfig } = require('../shared/instance-config.cjs');
const {
  normalizeAllowedHosts,
  reconcileAllowedHosts
} = require('../shared/public-host-policy.cjs');
const { strictInteger, tunnelProvider: validateTunnelProvider } = require('./tunnel-settings.js');

const REQUEST_POLICY_LIMITS = Object.freeze({
  maxRequestBytes: [65536, 33554432],
  requestsPerMinute: [10, 10000],
  maxConcurrentRequests: [1, 256],
  maxConcurrentPerPrincipal: [1, 64],
  requestTimeoutMs: [1000, 3600000]
});

function cleanHttpsOrigin(value, { required = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw new Error('A public HTTPS URL is required');
    return '';
  }
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== '/')
  ) throw new Error('publicUrl must be a clean HTTPS origin');
  return `https://${url.host}`;
}

function connectionState(config) {
  const normalized = normalizeInstanceConfig(config);
  return {
    provider: validateTunnelProvider(String(normalized.connection.provider || 'ngrok').trim().toLowerCase()),
    publicUrl: cleanHttpsOrigin(normalized.connection.publicUrl || '')
  };
}

function readInstanceConfig(file) {
  const config = readJson(file, null, { strict: true, supportedVersion: true });
  if (!config) return null;
  normalizeInstanceConfig(config);
  return {
    config,
    connection: connectionState(config),
    leaseRequired: config.team.requireWorkspaceLeaseForWrites === true,
    allowedHosts: normalizeAllowedHosts(config.requestPolicy.allowedHosts || []),
    requestPolicy: { ...config.requestPolicy }
  };
}

function assertConnectionConfiguration({ provider, publicUrl }) {
  if ((provider === 'cloudflare-managed' || provider === 'external') && !publicUrl) {
    throw new Error(`${provider} requires a public HTTPS URL`);
  }
}

function applyInstancePatch(file, patch = {}) {
  return updateConfig(file, config => {
    if (!Object.keys(config).length) throw new Error('DevMate shared config must exist before instance configuration');
    normalizeInstanceConfig(config);

    const current = connectionState(config);
    const provider = patch.provider !== undefined
      ? validateTunnelProvider(String(patch.provider).trim().toLowerCase())
      : current.provider;
    let publicUrl = current.publicUrl;
    if (patch.publicUrl !== undefined) publicUrl = cleanHttpsOrigin(patch.publicUrl);
    assertConnectionConfiguration({ provider, publicUrl });

    const connectionTouched = patch.provider !== undefined || patch.publicUrl !== undefined;
    if (patch.allowedHosts !== undefined) {
      config.requestPolicy.allowedHosts = normalizeAllowedHosts(patch.allowedHosts);
    } else if (connectionTouched) {
      config.requestPolicy.allowedHosts = reconcileAllowedHosts({
        currentAllowedHosts: config.requestPolicy.allowedHosts || [],
        previousPublicUrl: current.publicUrl,
        nextPublicUrl: publicUrl
      });
    }

    config.connection.provider = provider;
    config.connection.publicUrl = publicUrl;

    if (patch.requireWorkspaceLeaseForWrites !== undefined) {
      if (typeof patch.requireWorkspaceLeaseForWrites !== 'boolean') {
        throw new TypeError('requireWorkspaceLeaseForWrites must be a boolean');
      }
      config.team.requireWorkspaceLeaseForWrites = patch.requireWorkspaceLeaseForWrites;
    }

    for (const [key, [min, max]] of Object.entries(REQUEST_POLICY_LIMITS)) {
      if (patch[key] === undefined) continue;
      config.requestPolicy[key] = strictInteger(patch[key], config.requestPolicy[key], min, max, key);
    }
    return config;
  });
}

module.exports = {
  REQUEST_POLICY_LIMITS,
  applyInstancePatch,
  assertConnectionConfiguration,
  cleanHttpsOrigin,
  connectionState,
  readInstanceConfig
};
