'use strict';

const { readJson, updateConfig } = require('../shared/config-store.cjs');
const {
  deploymentMode: validateDeploymentMode,
  strictInteger,
  tunnelProvider: validateTunnelProvider
} = require('./tunnel-settings.js');

const PRODUCTION_LIMITS = Object.freeze({
  maxRequestBytes: [65536, 33554432],
  requestsPerMinute: [10, 10000],
  maxConcurrentRequests: [1, 256],
  maxConcurrentPerPrincipal: [1, 64],
  requestTimeoutMs: [1000, 3600000]
});

function cleanHttpsOrigin(value, { required = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) throw new Error('A stable public HTTPS URL is required');
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

function normalizeHostList(values) {
  if (!Array.isArray(values)) throw new TypeError('allowedHosts must be an array');
  return [...new Set(values
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
}

function deploymentState(config) {
  const deployment = config?.deployment || {};
  return {
    mode: validateDeploymentMode(String(deployment.mode || 'personal').trim().toLowerCase()),
    tunnelProvider: validateTunnelProvider(String(deployment.tunnelProvider || 'ngrok').trim().toLowerCase()),
    publicUrl: cleanHttpsOrigin(deployment.publicUrl || '')
  };
}

function readDeploymentConfig(file) {
  const config = readJson(file, null, { strict: true, supportedVersion: true });
  if (!config) return null;
  return {
    config,
    deployment: deploymentState(config),
    leaseRequired: config.team?.requireWorkspaceLeaseForWrites === true,
    allowedHosts: normalizeHostList(config.production?.allowedHosts || [])
  };
}

function assertDeployableTransition({ mode, provider, publicUrl, touched }) {
  if (!touched) return;
  if (mode === 'production' && provider === 'cloudflare-quick') {
    throw new Error('Cloudflare Quick Tunnel cannot be used in production mode');
  }
  if ((provider === 'cloudflare-managed' || provider === 'external') && !publicUrl) {
    throw new Error(`${provider} requires a stable public HTTPS URL`);
  }
  if (mode === 'production' && !publicUrl) {
    throw new Error('Production deployment requires a stable public HTTPS URL');
  }
}

function applyDeploymentPatch(file, patch = {}) {
  return updateConfig(file, config => {
    if (!Object.keys(config).length) throw new Error('DevMate shared config must exist before deployment configuration');
    config.deployment ||= { mode: 'personal', tunnelProvider: 'ngrok', publicUrl: '' };
    config.team ||= {};
    config.production ||= {};

    const current = deploymentState(config);
    const mode = patch.mode !== undefined
      ? validateDeploymentMode(String(patch.mode).trim().toLowerCase())
      : current.mode;
    const provider = patch.tunnelProvider !== undefined
      ? validateTunnelProvider(String(patch.tunnelProvider).trim().toLowerCase())
      : current.tunnelProvider;
    let publicUrl = current.publicUrl;
    if (patch.publicUrl !== undefined) publicUrl = cleanHttpsOrigin(patch.publicUrl);

    const deploymentTouched = patch.mode !== undefined || patch.tunnelProvider !== undefined || patch.publicUrl !== undefined;
    assertDeployableTransition({ mode, provider, publicUrl, touched: deploymentTouched });

    config.deployment.mode = mode;
    config.deployment.tunnelProvider = provider;
    config.deployment.publicUrl = publicUrl;
    config.team.enabled = mode !== 'personal';

    if (patch.requireWorkspaceLeaseForWrites !== undefined) {
      if (typeof patch.requireWorkspaceLeaseForWrites !== 'boolean') {
        throw new TypeError('requireWorkspaceLeaseForWrites must be a boolean');
      }
      config.team.requireWorkspaceLeaseForWrites = patch.requireWorkspaceLeaseForWrites;
    }

    for (const [key, [min, max]] of Object.entries(PRODUCTION_LIMITS)) {
      if (patch[key] === undefined) continue;
      config.production[key] = strictInteger(patch[key], config.production[key], min, max, key);
    }
    if (patch.allowedHosts !== undefined) config.production.allowedHosts = normalizeHostList(patch.allowedHosts);
    return config;
  });
}

module.exports = {
  PRODUCTION_LIMITS,
  applyDeploymentPatch,
  assertDeployableTransition,
  cleanHttpsOrigin,
  deploymentState,
  normalizeHostList,
  readDeploymentConfig
};
