'use strict';

const { updateConfig } = require('./config-store.cjs');
const {
  configurePermissionPolicy,
  markPermissionPolicyInitialized,
  permissionPolicyInitialized,
  permissionPolicySnapshot
} = require('./permission-config.cjs');

function ensureDesktopPermissionPolicy(configFile, { fresh = false, defaults = {} } = {}) {
  let permissions = null;
  const config = updateConfig(configFile, current => {
    if (permissionPolicyInitialized(current)) {
      permissions = permissionPolicySnapshot(current);
      return current;
    }
    if (fresh) {
      configurePermissionPolicy(current, defaults, { replace: true });
    } else {
      current.permissions = permissionPolicySnapshot(current);
      markPermissionPolicyInitialized(current);
    }
    permissions = permissionPolicySnapshot(current);
    return current;
  });
  return { config, permissions: permissions || permissionPolicySnapshot(config) };
}

function setDesktopPermissionPolicy(configFile, requested = {}) {
  let permissions = null;
  const config = updateConfig(configFile, current => {
    configurePermissionPolicy(current, requested, { replace: true });
    permissions = permissionPolicySnapshot(current);
    return current;
  });
  return { config, permissions: permissions || permissionPolicySnapshot(config) };
}

module.exports = {
  ensureDesktopPermissionPolicy,
  setDesktopPermissionPolicy
};
