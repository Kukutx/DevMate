'use strict';

const configStore = require('./config-store.cjs');
const authConfig = require('./auth-config.cjs');
const oauthSecrets = require('./oauth-secrets.cjs');

const { updateConfig } = configStore;
const {
  DEFAULT_AUTHENTICATION_MODE,
  authenticationMode,
  authenticationPolicyInitialized,
  configureAuthentication,
  markAuthenticationPolicyInitialized
} = authConfig;
const { ensureOAuthSecrets } = oauthSecrets;

function ensureDesktopAuthenticationPolicy(configFile, {
  fresh = false,
  defaultMode = DEFAULT_AUTHENTICATION_MODE
} = {}) {
  let mode = DEFAULT_AUTHENTICATION_MODE;
  const config = updateConfig(configFile, current => {
    if (authenticationPolicyInitialized(current)) {
      mode = authenticationMode(current.auth?.mode);
      return current;
    }
    if (fresh) {
      mode = authenticationMode(defaultMode);
      configureAuthentication(current, mode, { replace: true });
    } else {
      mode = authenticationMode(current.auth?.mode);
      current.auth = { mode };
      markAuthenticationPolicyInitialized(current);
    }
    return current;
  });
  mode = authenticationMode(config.auth?.mode);
  if (mode === 'oauth') ensureOAuthSecrets(configFile);
  return { config, mode };
}

function setDesktopAuthenticationMode(configFile, requestedMode) {
  const mode = authenticationMode(requestedMode);
  const config = updateConfig(configFile, current => {
    configureAuthentication(current, mode, { replace: true });
    return current;
  });
  if (mode === 'oauth') ensureOAuthSecrets(configFile);
  return { config, mode };
}

module.exports = {
  ensureDesktopAuthenticationPolicy,
  setDesktopAuthenticationMode
};
