'use strict';

const { updateConfig } = require('./config-store.cjs');
const {
  configurePermissionPolicy,
  markPermissionPolicyInitialized,
  permissionPolicyInitialized,
  permissionPolicySnapshot
} = require('./permission-config.cjs');

function normalizeStoredPermissionPolicy(current) {
  const effective = permissionPolicySnapshot(current);
  const raw = current.permissions && typeof current.permissions === 'object' && !Array.isArray(current.permissions)
    ? current.permissions
    : null;
  if (!raw || JSON.stringify(raw) !== JSON.stringify(effective)) {
    current.permissions = { ...effective };
  }
  return effective;
}

function ensureDesktopPermissionPolicy(configFile, { fresh = false, defaults = {} } = {}) {
  let permissions = null;
  const config = updateConfig(configFile, current => {
    if (permissionPolicyInitialized(current)) {
      permissions = normalizeStoredPermissionPolicy(current);
      return current;
    }
    if (fresh) {
      configurePermissionPolicy(current, defaults, { replace: true });
    } else {
      current.permissions = permissionPolicySnapshot(current);
      markPermissionPolicyInitialized(current);
    }
    permissions = normalizeStoredPermissionPolicy(current);
    return current;
  });
  return { config, permissions: permissions || permissionPolicySnapshot(config) };
}

function setDesktopPermissionPolicy(configFile, requested = {}) {
  let permissions = null;
  const config = updateConfig(configFile, current => {
    configurePermissionPolicy(current, requested, { replace: true });
    permissions = normalizeStoredPermissionPolicy(current);
    return current;
  });
  return { config, permissions: permissions || permissionPolicySnapshot(config) };
}

module.exports = {
  ensureDesktopPermissionPolicy,
  setDesktopPermissionPolicy
};
