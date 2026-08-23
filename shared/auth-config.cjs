'use strict';

const AUTHENTICATION_MODES = Object.freeze(['none', 'oauth']);
const DEFAULT_AUTHENTICATION_MODE = 'oauth';

function object(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function authenticationMode(value) {
  const mode = value === undefined ? DEFAULT_AUTHENTICATION_MODE : String(value).trim().toLowerCase();
  if (!AUTHENTICATION_MODES.includes(mode)) throw new Error(`Unknown DevMate authentication mode: ${String(value)}`);
  return mode;
}

function normalizeAuthentication(config) {
  const source = object(config?.auth, 'auth');
  const mode = authenticationMode(source.mode);
  const keys = Object.keys(source).filter(key => key !== 'mode');
  if (keys.length) {
    const error = new Error(`Unsupported authentication fields: ${keys.join(', ')}`);
    error.code = 'unsupported_auth_shape';
    throw error;
  }
  return { mode };
}

function configureAuthentication(config, requestedMode) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  const current = object(config.auth, 'auth');
  const mode = authenticationMode(requestedMode === undefined ? current.mode : requestedMode);
  config.auth = { mode };
  return config.auth;
}

module.exports = {
  AUTHENTICATION_MODES,
  DEFAULT_AUTHENTICATION_MODE,
  authenticationMode,
  configureAuthentication,
  normalizeAuthentication
};
