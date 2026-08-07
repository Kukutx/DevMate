'use strict';

const PROVIDERS = Object.freeze(['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
const DEPLOYMENT_MODES = Object.freeze(['personal', 'team', 'production']);

function strictEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Unknown ${label}: ${String(value)}`);
  }
  return value;
}

function strictInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function tunnelProvider(value) {
  return strictEnum(value, PROVIDERS, 'tunnel provider');
}

function deploymentMode(value) {
  return strictEnum(value, DEPLOYMENT_MODES, 'deployment mode');
}

function tunnelMaxRestarts(value) {
  return strictInteger(value, 10, 0, 100, 'tunnelMaxRestarts');
}

module.exports = {
  DEPLOYMENT_MODES,
  PROVIDERS,
  deploymentMode,
  strictInteger,
  tunnelMaxRestarts,
  tunnelProvider
};
