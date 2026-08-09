'use strict';

const PERMISSION_PROFILES = Object.freeze(['readOnly', 'balanced', 'fullAccess']);
const BOOLEAN_FIELDS = Object.freeze([
  'readOnly',
  'blockDangerousOperations',
  'confirmBeforePush',
  'allowDirectoryMutations'
]);

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

module.exports = {
  BOOLEAN_FIELDS,
  PERMISSION_PROFILES,
  validatePermissionConfig
};
