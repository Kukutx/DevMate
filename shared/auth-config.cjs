'use strict';

const AUTHENTICATION_MODES = Object.freeze(['none', 'oauth']);
const DEFAULT_AUTHENTICATION_MODE = 'none';
const AUTH_POLICY_INITIALIZED_KEY = 'authenticationPolicyInitialized';
const AUTH_POLICY_GENERATION_KEY = 'authenticationPolicyGeneration';

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

function authenticationPolicyGeneration(config) {
  const value = config?.hostRuntime?.[AUTH_POLICY_GENERATION_KEY];
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    const error = new Error(`Invalid DevMate authentication policy generation: ${String(value)}`);
    error.code = 'invalid_authentication_policy_generation';
    throw error;
  }
  return value;
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
  authenticationPolicyGeneration(config);
  return { mode };
}

function authenticationPolicyInitialized(config) {
  return config?.hostRuntime?.[AUTH_POLICY_INITIALIZED_KEY] === true;
}

function markAuthenticationPolicyInitialized(config) {
  config.hostRuntime ||= {};
  config.hostRuntime[AUTH_POLICY_INITIALIZED_KEY] = true;
  if (!Object.hasOwn(config.hostRuntime, AUTH_POLICY_GENERATION_KEY)) {
    config.hostRuntime[AUTH_POLICY_GENERATION_KEY] = 0;
  } else {
    authenticationPolicyGeneration(config);
  }
  return config.hostRuntime;
}

/**
 * Normalize authentication without allowing routine host refreshes to fight over
 * one shared instance policy. The first explicit request establishes the policy;
 * later callers preserve it unless replace=true is supplied by a deliberate user
 * or bootstrap action. A real mode transition increments a monotonic generation
 * so verification evidence cannot survive an OAuth -> none -> OAuth ABA change.
 */
function configureAuthentication(config, requestedMode, { replace = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  const current = object(config.auth, 'auth');
  const currentMode = authenticationMode(current.mode);
  const requested = requestedMode === undefined ? currentMode : authenticationMode(requestedMode);
  const initialized = authenticationPolicyInitialized(config);
  const generation = authenticationPolicyGeneration(config);
  const mode = requestedMode === undefined || (initialized && !replace) ? currentMode : requested;

  if (mode !== currentMode && generation >= Number.MAX_SAFE_INTEGER) {
    const error = new Error('DevMate authentication policy generation is exhausted');
    error.code = 'authentication_policy_generation_exhausted';
    throw error;
  }

  config.auth = { mode };
  if (requestedMode !== undefined || replace) markAuthenticationPolicyInitialized(config);
  if (mode !== currentMode) {
    config.hostRuntime ||= {};
    config.hostRuntime[AUTH_POLICY_GENERATION_KEY] = generation + 1;
  }
  return config.auth;
}

module.exports = {
  AUTHENTICATION_MODES,
  AUTH_POLICY_GENERATION_KEY,
  AUTH_POLICY_INITIALIZED_KEY,
  DEFAULT_AUTHENTICATION_MODE,
  authenticationMode,
  authenticationPolicyGeneration,
  authenticationPolicyInitialized,
  configureAuthentication,
  markAuthenticationPolicyInitialized,
  normalizeAuthentication
};
