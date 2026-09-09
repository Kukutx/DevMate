'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_PERMISSION_POLICY,
  PERMISSION_PROFILES,
  configurePermissionPolicy,
  permissionPolicySnapshot,
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

test('missing permissions uses the complete fullAccess default but a provided policy requires an explicit profile', () => {
  assert.deepEqual(validatePermissionConfig({}), { profile: 'fullAccess' });
  assert.deepEqual(permissionPolicySnapshot({}), DEFAULT_PERMISSION_POLICY);
  assert.deepEqual(DEFAULT_PERMISSION_POLICY, {
    profile: 'fullAccess',
    readOnly: false,
    blockDangerousOperations: false,
    confirmBeforePush: false,
    allowDirectoryMutations: true
  });
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

test('legacy restrictive booleans cannot partially restrict fullAccess', () => {
  const config = {
    permissions: {
      profile: 'fullAccess',
      readOnly: false,
      blockDangerousOperations: true,
      confirmBeforePush: true,
      allowDirectoryMutations: false
    },
    hostRuntime: { permissionPolicyInitialized: true, permissionPolicyGeneration: 9 }
  };
  assert.deepEqual(permissionPolicySnapshot(config), DEFAULT_PERMISSION_POLICY);
  configurePermissionPolicy(config, config.permissions, { replace: true });
  assert.deepEqual(config.permissions, DEFAULT_PERMISSION_POLICY);
  assert.equal(config.hostRuntime.permissionPolicyGeneration, 9, 'canonical representation is not a semantic policy change');
});

test('balanced keeps independent guard preferences while fullAccess always stays canonical', () => {
  const config = {
    permissions: {
      profile: 'balanced',
      readOnly: false,
      blockDangerousOperations: false,
      confirmBeforePush: true,
      allowDirectoryMutations: true
    },
    hostRuntime: { permissionPolicyInitialized: true, permissionPolicyGeneration: 3 }
  };
  assert.deepEqual(permissionPolicySnapshot(config), config.permissions);

  configurePermissionPolicy(config, { profile: 'fullAccess', readOnly: false, blockDangerousOperations: true, confirmBeforePush: true, allowDirectoryMutations: false }, { replace: true });
  assert.deepEqual(config.permissions, DEFAULT_PERMISSION_POLICY);
  assert.equal(config.hostRuntime.permissionPolicyGeneration, 4);
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

test('move overwrite cannot replace an existing destination directory without the directory-mutation gate', () => {
  const source = fs.readFileSync(path.join(root, 'gateway', 'file-mutation-safety.mjs'), 'utf8');
  const start = source.indexOf('async function moveFileTool(');
  const end = source.indexOf('async function restoreBackupTool(', start);
  assert.ok(start >= 0 && end > start);
  const move = source.slice(start, end);
  assert.match(move, /if \(targetStat\) await assertDirectoryMutationAllowed\(config, workspace, target, to\)/);
  assert.match(move, /transactionalMove\(\{[\s\S]*overwrite: !!overwrite/);
});
