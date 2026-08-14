'use strict';

const crypto = require('node:crypto');

const AUTHENTICATION_MODES = Object.freeze(['none', 'oauth']);

function object(value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomApprovalCode() {
  return crypto.randomBytes(18).toString('base64url');
}

function authenticationMode(value) {
  const mode = value === undefined ? 'none' : String(value).trim().toLowerCase();
  if (!AUTHENTICATION_MODES.includes(mode)) throw new Error(`Unknown DevMate authentication mode: ${String(value)}`);
  return mode;
}

function normalizeAuthentication(config) {
  const source = object(config?.auth, 'auth');
  const mode = authenticationMode(source.mode);
  const auth = { mode };
  if (mode === 'oauth') {
    const oauth = object(source.oauth, 'auth.oauth');
    const signingKey = String(oauth.signingKey || '').trim();
    const approvalCode = String(oauth.approvalCode || '').trim();
    if (signingKey.length < 32 || approvalCode.length < 16) {
      throw new Error('OAuth authentication is incomplete. Reconfigure DevMate authentication before starting the Gateway.');
    }
    auth.oauth = { signingKey, approvalCode };
  }
  return auth;
}

function configureAuthentication(config, requestedMode) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  const current = config.auth && typeof config.auth === 'object' && !Array.isArray(config.auth) ? config.auth : {};
  const mode = authenticationMode(requestedMode === undefined ? current.mode : requestedMode);
  if (mode === 'none') {
    config.auth = { mode: 'none' };
    return config.auth;
  }
  const oauth = current.oauth && typeof current.oauth === 'object' && !Array.isArray(current.oauth) ? current.oauth : {};
  config.auth = {
    mode: 'oauth',
    oauth: {
      signingKey: String(oauth.signingKey || '').trim() || randomSecret(),
      approvalCode: String(oauth.approvalCode || '').trim() || randomApprovalCode()
    }
  };
  return config.auth;
}

module.exports = {
  AUTHENTICATION_MODES,
  authenticationMode,
  configureAuthentication,
  normalizeAuthentication,
  randomApprovalCode,
  randomSecret
};
