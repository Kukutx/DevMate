'use strict';

const AUTHENTICATION_MODES = Object.freeze(['none', 'oauth']);
const DEFAULT_AUTHENTICATION_MODE = 'oauth';
const AUTH_POLICY_INITIALIZED_KEY = 'authenticationPolicyInitialized';

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

function authenticationPolicyInitialized(config) {
  return config?.hostRuntime?.[AUTH_POLICY_INITIALIZED_KEY] === true;
}

function markAuthenticationPolicyInitialized(config) {
  config.hostRuntime ||= {};
  config.hostRuntime[AUTH_POLICY_INITIALIZED_KEY] = true;
  return config.hostRuntime;
}

/**
 * Normalize authentication without allowing routine host refreshes to fight over
 * one shared instance policy. The first explicit request establishes the policy;
 * later callers preserve it unless replace=true is supplied by a deliberate user
 * or bootstrap action.
 */
function configureAuthentication(config, requestedMode, { replace = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  const current = object(config.auth, 'auth');
  const currentMode = authenticationMode(current.mode);
  const requested = requestedMode === undefined ? currentMode : authenticationMode(requestedMode);
  const initialized = authenticationPolicyInitialized(config);
  const mode = requestedMode === undefined || (initialized && !replace) ? currentMode : requested;
  config.auth = { mode };
  if (requestedMode !== undefined || replace) markAuthenticationPolicyInitialized(config);
  return config.auth;
}

module.exports = {
  AUTHENTICATION_MODES,
  AUTH_POLICY_INITIALIZED_KEY,
  DEFAULT_AUTHENTICATION_MODE,
  authenticationMode,
  authenticationPolicyInitialized,
  configureAuthentication,
  markAuthenticationPolicyInitialized,
  normalizeAuthentication
};
