'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  PERMISSION_PROFILES,
  validatePermissionConfig
} = require('../shared/permission-config.cjs');

const root = path.resolve(__dirname, '..');

test('accepts only the current explicit permission profiles', () => {
  assert.deepEqual(PERMISSION_PROFILES, ['readOnly', 'balanced', 'fullAccess']);
  assert.deepEqual(validatePermissionConfig({ permissions: { profile: 'readOnly', readOnly: true } }), { profile: 'readOnly' });
  assert.deepEqual(validatePermissionConfig({ permissions: { profile: 'balanced', readOnly: false } }), { profile: 'balanced' });
  assert.deepEqual(validatePermissionConfig({ permissions: { profile: 'fullAccess', readOnly: false } }), { profile: 'fullAccess' });
  assert.throws(
    () => validatePermissionConfig({ permissions: { profile: 'administrator', readOnly: false } }),
    error => error?.code === 'DEVMATE_PERMISSION_CONFIG_INVALID' && error.field === 'permissions.profile'
  );
});

test('missing permissions uses the current default but a provided policy requires an explicit profile', () => {
  assert.deepEqual(validatePermissionConfig({}), { profile: 'fullAccess' });
  assert.throws(
    () => validatePermissionConfig({ permissions: {} }),
    error => error?.code === 'DEVMATE_PERMISSION_CONFIG_INVALID' && error.field === 'permissions.profile'
  );
  assert.throws(
    () => validatePermissionConfig({ permissions: { readOnly: true } }),
    error => error?.code === 'DEVMATE_PERMISSION_CONFIG_INVALID' && error.field === 'permissions.profile'
  );
  assert.throws(
    () => validatePermissionConfig({ permissions: { readOnly: false } }),
    error => error?.code === 'DEVMATE_PERMISSION_CONFIG_INVALID' && error.field === 'permissions.profile'
  );
});

test('rejects contradictory or wrong-typed permission policy instead of entering a partial profile state', () => {
  assert.throws(() => validatePermissionConfig({ permissions: { profile: 'fullAccess', readOnly: true } }), /conflicts/);
  assert.throws(() => validatePermissionConfig({ permissions: { profile: 'readOnly', readOnly: false } }), /conflicts/);
  for (const field of ['blockDangerousOperations', 'confirmBeforePush', 'allowDirectoryMutations']) {
    assert.throws(
      () => validatePermissionConfig({ permissions: { profile: 'fullAccess', readOnly: false, [field]: 1 } }),
      error => error?.code === 'DEVMATE_PERMISSION_CONFIG_INVALID' && error.field === `permissions.${field}`
    );
  }
});

test('Gateway validates permission configuration before acquiring the central instance lock', () => {
  const source = fs.readFileSync(path.join(root, 'gateway', 'server-runtime.mjs'), 'utf8');
  assert.match(source, /validatePermissionConfig\(startupConfig\)/);
  const config = source.indexOf('const startupConfig = readConfig()');
  const permissions = source.indexOf('validatePermissionConfig(startupConfig)');
  const lock = source.indexOf('acquireGatewayInstanceLock()');
  assert.ok(config >= 0 && permissions > config && lock > permissions);
});
