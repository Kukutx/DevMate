'use strict';

const PERMISSION_PROFILES = Object.freeze(['readOnly', 'balanced', 'fullAccess']);
const BOOLEAN_FIELDS = Object.freeze([
  'readOnly',
  'blockDangerousOperations',
  'confirmBeforePush',
  'allowDirectoryMutations'
]);
const PERMISSION_POLICY_INITIALIZED_KEY = 'permissionPolicyInitialized';
const PERMISSION_POLICY_GENERATION_KEY = 'permissionPolicyGeneration';
const DEFAULT_PERMISSION_POLICY = Object.freeze({
  profile: 'fullAccess',
  readOnly: false,
  blockDangerousOperations: true,
  confirmBeforePush: false,
  allowDirectoryMutations: false
});

function invalidPermission(message, field = '') {
  const error = new Error(message);
  error.code = 'DEVMATE_PERMISSION_CONFIG_INVALID';
  error.field = field;
  return error;
}

function validatePermissionConfig(config = {}) {
  const permissions = config?.permissions;
  if (permissions === undefined || permissions === null) return { profile: 'fullAccess' };
  if (typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw invalidPermission('permissions must be an object', 'permissions');
  }

  for (const field of BOOLEAN_FIELDS) {
    if (permissions[field] !== undefined && typeof permissions[field] !== 'boolean') {
      throw invalidPermission(`permissions.${field} must be a boolean`, `permissions.${field}`);
    }
  }

  const profile = permissions.profile;
  if (typeof profile !== 'string' || !PERMISSION_PROFILES.includes(profile)) {
    throw invalidPermission(
      `permissions.profile must be one of: ${PERMISSION_PROFILES.join(', ')}`,
      'permissions.profile'
    );
  }

  if (permissions.readOnly === true && profile !== 'readOnly') {
    throw invalidPermission('permissions.readOnly=true conflicts with permissions.profile', 'permissions.readOnly');
  }
  if (permissions.readOnly === false && profile === 'readOnly') {
    throw invalidPermission('permissions.readOnly=false conflicts with permissions.profile=readOnly', 'permissions.readOnly');
  }

  return { profile };
}

function permissionPolicyGeneration(config) {
  const value = config?.hostRuntime?.[PERMISSION_POLICY_GENERATION_KEY];
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    const error = invalidPermission(`Invalid DevMate permission policy generation: ${String(value)}`, PERMISSION_POLICY_GENERATION_KEY);
    error.code = 'invalid_permission_policy_generation';
    throw error;
  }
  return value;
}

function permissionPolicyInitialized(config) {
  return config?.hostRuntime?.[PERMISSION_POLICY_INITIALIZED_KEY] === true;
}

function markPermissionPolicyInitialized(config) {
  config.hostRuntime ||= {};
  config.hostRuntime[PERMISSION_POLICY_INITIALIZED_KEY] = true;
  if (!Object.hasOwn(config.hostRuntime, PERMISSION_POLICY_GENERATION_KEY)) {
    config.hostRuntime[PERMISSION_POLICY_GENERATION_KEY] = 0;
  } else {
    permissionPolicyGeneration(config);
  }
  return config.hostRuntime;
}

function permissionPolicySnapshot(config = {}) {
  const source = config?.permissions;
  if (source === undefined || source === null) return { ...DEFAULT_PERMISSION_POLICY };
  validatePermissionConfig(config);
  const profile = source.profile;
  return {
    profile,
    readOnly: source.readOnly === undefined ? profile === 'readOnly' : source.readOnly,
    blockDangerousOperations: source.blockDangerousOperations === undefined ? true : source.blockDangerousOperations,
    confirmBeforePush: source.confirmBeforePush === true,
    allowDirectoryMutations: source.allowDirectoryMutations === true
  };
}

function requestedPermissionPolicy(current, requested = {}) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw invalidPermission('permission policy request must be an object', 'permissions');
  }
  const profile = requested.profile === undefined ? current.profile : requested.profile;
  const profileChanged = profile !== current.profile;
  const next = {
    profile,
    readOnly: requested.readOnly === undefined ? (profileChanged ? profile === 'readOnly' : current.readOnly) : requested.readOnly,
    blockDangerousOperations: requested.blockDangerousOperations === undefined ? current.blockDangerousOperations : requested.blockDangerousOperations,
    confirmBeforePush: requested.confirmBeforePush === undefined ? current.confirmBeforePush : requested.confirmBeforePush,
    allowDirectoryMutations: requested.allowDirectoryMutations === undefined ? current.allowDirectoryMutations : requested.allowDirectoryMutations
  };
  validatePermissionConfig({ permissions: next });
  return next;
}

/**
 * Establish one machine-wide permission policy and keep routine host refreshes
 * from replacing it. Only an explicit replace=true transition may change an
 * initialized policy. Every committed transition advances a monotonic generation
 * so stale host snapshots cannot silently restore an older policy.
 */
function configurePermissionPolicy(config, requested = {}, { replace = false } = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('DevMate config must be an object');
  const current = permissionPolicySnapshot(config);
  const initialized = permissionPolicyInitialized(config);
  const generation = permissionPolicyGeneration(config);
  const candidate = requestedPermissionPolicy(current, requested);
  const next = initialized && !replace ? current : candidate;
  const changed = JSON.stringify(next) !== JSON.stringify(current);

  if (initialized && changed && generation >= Number.MAX_SAFE_INTEGER) {
    const error = new Error('DevMate permission policy generation is exhausted');
    error.code = 'permission_policy_generation_exhausted';
    throw error;
  }

  config.permissions = { ...next };
  markPermissionPolicyInitialized(config);
  if (initialized && changed) {
    config.hostRuntime[PERMISSION_POLICY_GENERATION_KEY] = generation + 1;
  }
  return config.permissions;
}

module.exports = {
  BOOLEAN_FIELDS,
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_PROFILES,
  PERMISSION_POLICY_GENERATION_KEY,
  PERMISSION_POLICY_INITIALIZED_KEY,
  configurePermissionPolicy,
  markPermissionPolicyInitialized,
  permissionPolicyGeneration,
  permissionPolicyInitialized,
  permissionPolicySnapshot,
  validatePermissionConfig
};
