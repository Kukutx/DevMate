'use strict';

const PROVIDERS = Object.freeze(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
const DEPLOYMENT_MODES = Object.freeze(['personal', 'team', 'production']);

function strictEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Unknown ${label}: ${String(value)}`);
  }
  return value;
}

function tunnelProvider(value) {
  return strictEnum(value, PROVIDERS, 'tunnel provider');
}

function deploymentMode(value) {
  return strictEnum(value, DEPLOYMENT_MODES, 'deployment mode');
}

module.exports = {
  DEPLOYMENT_MODES,
  PROVIDERS,
  deploymentMode,
  tunnelProvider
};
