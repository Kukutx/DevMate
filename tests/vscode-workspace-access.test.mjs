import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import configStore from '../shared/config-store.cjs';
import workspaceAccess from '../vscode-host/workspace-access.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixture() {
  const state = tempDir('devmate-workspace-access-state-');
  const current = tempDir('devmate-workspace-access-current-');
  const configFile = path.join(state, 'config.json');
  const config = configStore.newInstanceConfig({
    workspaceRoot: current,
    port: 8787,
    appVersion: configStore.DEFAULT_VERSION,
    defaultConnectionProvider: 'ngrok'
  });
  config.permissions = {
    ...(config.permissions || {}),
    profile: 'fullAccess',
    readOnly: false,
    blockDangerousOperations: false
  };
  configStore.atomicWriteJson(configFile, config);
  return { state, current, configFile };
}

test('VS Code keeps one current project while exposing multiple additional writable workspaces', () => {
  const { current, configFile } = fixture();
  const one = tempDir('devmate-workspace-access-one-');
  const two = tempDir('devmate-workspace-access-two-');

  const first = workspaceAccess.addWorkspaceAccess(configFile, one, 'One');
  const second = workspaceAccess.addWorkspaceAccess(configFile, two, 'Two');
  assert.equal(first.added, true);
  assert.equal(second.added, true);

  const state = workspaceAccess.listWorkspaceAccess(configFile);
  assert.equal(path.resolve(state.current.root), path.resolve(current));
  assert.deepEqual(state.additional.map(item => item.name).sort(), ['One', 'Two']);
  assert.ok(state.additional.every(item => item.writable === true));

  const stored = configStore.readConfigSnapshot(configFile);
  assert.equal(stored.activeWorkspaceId, state.current.id);
  assert.equal(stored.trustedWritableRoots.length, 2);
  assert.equal(stored.workspaces.filter(item => item.role === 'trusted').length, 2);
});

test('adding the current project again is idempotent and does not create a second writable identity', () => {
  const { current, configFile } = fixture();
  const result = workspaceAccess.addWorkspaceAccess(configFile, current);
  assert.equal(result.added, false);
  assert.equal(result.reason, 'already-configured-as-current-or-workspace');
  assert.equal(workspaceAccess.listWorkspaceAccess(configFile).additional.length, 0);
});

test('additional workspaces use the same stable trusted workspace id shape as the Gateway', () => {
  const root = tempDir('devmate-workspace-access-id-');
  const normalized = workspaceAccess.normalizeAdditionalWorkspace(root, 'App');
  assert.match(normalized.id, /^trusted-[a-f0-9]{12}$/);
  assert.equal(normalized.id, workspaceAccess.additionalWorkspaceId(fs.realpathSync.native(root)));
});

test('protected control-plane roots are rejected before they reach shared config', () => {
  const base = tempDir('devmate-workspace-access-protected-');
  const protectedRoot = path.join(base, '.devmate', 'desktop');
  fs.mkdirSync(protectedRoot, { recursive: true });
  assert.throws(
    () => workspaceAccess.normalizeAdditionalWorkspace(protectedRoot),
    error => error?.code === 'protected_workspace_root'
  );
});

test('removing an additional workspace revokes both trusted-root and workspace entries', () => {
  const { configFile } = fixture();
  const root = tempDir('devmate-workspace-access-remove-');
  const added = workspaceAccess.addWorkspaceAccess(configFile, root, 'Remove Me');
  const removed = workspaceAccess.removeWorkspaceAccess(configFile, { id: added.workspace.id });
  assert.equal(removed.removed, true);
  const state = workspaceAccess.listWorkspaceAccess(configFile);
  assert.equal(state.additional.length, 0);
  const stored = configStore.readConfigSnapshot(configFile);
  assert.equal(stored.trustedWritableRoots.length, 0);
  assert.equal(stored.workspaces.some(item => item.id === added.workspace.id), false);
});

test('workspace access mutation requires fullAccess while listing remains available', () => {
  const { configFile } = fixture();
  const config = configStore.readConfigSnapshot(configFile);
  config.permissions.profile = 'balanced';
  configStore.atomicWriteJson(configFile, config);
  const root = tempDir('devmate-workspace-access-balanced-');
  assert.throws(() => workspaceAccess.addWorkspaceAccess(configFile, root), /requires the fullAccess permission profile/);
  assert.equal(workspaceAccess.listWorkspaceAccess(configFile).permissionProfile, 'balanced');
});
