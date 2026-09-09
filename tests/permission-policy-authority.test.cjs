'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const configStore = require('../shared/config-store.cjs');
const {
  DEFAULT_PERMISSION_POLICY,
  configurePermissionPolicy,
  permissionPolicyGeneration,
  permissionPolicyInitialized,
  permissionPolicySnapshot
} = require('../shared/permission-config.cjs');
const {
  ensureDesktopPermissionPolicy,
  setDesktopPermissionPolicy
} = require('../shared/desktop-permission-policy.cjs');
const { mergeExtensionConfig } = require('../vscode-host/config-sync.js');
const packageJson = require('../package.json');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-permission-policy-'));
  const file = path.join(root, 'state', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  configStore.ensureInstanceConfig({ configFile: file, workspaceRoot: root, preferredPort: 8787 });
  return { root, file };
}

test('routine host initialization cannot replace an established shared permission policy', t => {
  const { root, file } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const established = ensureDesktopPermissionPolicy(file, {
    fresh: false,
    defaults: { profile: 'readOnly', readOnly: true }
  });
  assert.equal(established.permissions.profile, 'fullAccess');
  assert.equal(permissionPolicyInitialized(established.config), true);
  assert.equal(permissionPolicyGeneration(established.config), 0);

  const changed = setDesktopPermissionPolicy(file, {
    profile: 'balanced',
    readOnly: false,
    blockDangerousOperations: true,
    confirmBeforePush: false,
    allowDirectoryMutations: false
  });
  assert.equal(changed.permissions.profile, 'balanced');
  assert.equal(permissionPolicyGeneration(changed.config), 1);

  const staleHost = ensureDesktopPermissionPolicy(file, {
    fresh: false,
    defaults: { profile: 'readOnly', readOnly: true }
  });
  assert.equal(staleHost.permissions.profile, 'balanced');
  assert.equal(permissionPolicyGeneration(staleHost.config), 1);
});

test('desktop startup canonicalizes legacy fullAccess storage without inventing a policy transition', t => {
  const { root, file } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  configStore.updateConfig(file, current => {
    current.permissions = {
      profile: 'fullAccess',
      readOnly: false,
      blockDangerousOperations: true,
      confirmBeforePush: true,
      allowDirectoryMutations: false
    };
    current.hostRuntime ||= {};
    current.hostRuntime.permissionPolicyInitialized = true;
    current.hostRuntime.permissionPolicyGeneration = 6;
    return current;
  });

  const normalized = ensureDesktopPermissionPolicy(file, { fresh: false });
  assert.deepEqual(normalized.permissions, DEFAULT_PERMISSION_POLICY);
  assert.deepEqual(normalized.config.permissions, DEFAULT_PERMISSION_POLICY);
  assert.equal(permissionPolicyGeneration(normalized.config), 6);

  const persisted = configStore.readConfigSnapshot(file);
  assert.deepEqual(persisted.permissions, DEFAULT_PERMISSION_POLICY);
  assert.equal(permissionPolicyGeneration(persisted), 6);
});

test('routine permission configuration is monotonic unless explicitly replaced', () => {
  const config = {
    permissions: {
      profile: 'fullAccess', readOnly: false, blockDangerousOperations: true,
      confirmBeforePush: false, allowDirectoryMutations: false
    },
    hostRuntime: { permissionPolicyInitialized: true, permissionPolicyGeneration: 4 }
  };
  configurePermissionPolicy(config, { profile: 'readOnly', readOnly: true });
  assert.equal(permissionPolicySnapshot(config).profile, 'fullAccess');
  assert.deepEqual(config.permissions, DEFAULT_PERMISSION_POLICY);
  assert.equal(permissionPolicyGeneration(config), 4);

  configurePermissionPolicy(config, { profile: 'readOnly', readOnly: true }, { replace: true });
  assert.equal(permissionPolicySnapshot(config).profile, 'readOnly');
  assert.equal(permissionPolicyGeneration(config), 5);
});

test('generic VS Code context refresh preserves shared permissions even with a stale candidate', () => {
  const current = {
    version: configStore.SUPPORTED_CONFIG_VERSION,
    instanceId: 'permission-authority',
    permissions: {
      profile: 'fullAccess', readOnly: false, blockDangerousOperations: true,
      confirmBeforePush: false, allowDirectoryMutations: false
    },
    hostRuntime: { permissionPolicyInitialized: true, permissionPolicyGeneration: 3 }
  };
  const candidate = {
    version: configStore.SUPPORTED_CONFIG_VERSION,
    permissions: {
      profile: 'readOnly', readOnly: true, blockDangerousOperations: true,
      confirmBeforePush: true, allowDirectoryMutations: false
    },
    hostContexts: { staleWindow: { capturedAt: 'later' } },
    activeHostId: 'staleWindow'
  };
  const merged = mergeExtensionConfig(current, candidate);
  assert.deepEqual(merged.permissions, current.permissions);
  assert.equal(merged.hostRuntime.permissionPolicyGeneration, 3);
  assert.deepEqual(merged.hostContexts.staleWindow, { capturedAt: 'later' });
});

test('fullAccess does not overwrite dormant balanced guard preferences in VS Code settings', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'vscode-host', 'lifecycle.js'), 'utf8');
  assert.match(source, /const expected = \{ permissionProfile: permissions\.profile \}/);
  assert.match(source, /if \(permissions\.profile !== 'fullAccess'\)/);
});

test('shared authentication and permission settings are machine-scoped in VS Code', () => {
  const properties = packageJson.contributes.configuration.properties;
  for (const name of [
    'devMate.authenticationMode',
    'devMate.permissionProfile',
    'devMate.blockDangerousOperations',
    'devMate.confirmBeforePush',
    'devMate.allowDirectoryMutations'
  ]) {
    assert.equal(properties[name].scope, 'machine', name);
  }
});
