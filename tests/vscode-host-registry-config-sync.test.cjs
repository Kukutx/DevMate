'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION } = require('../shared/config-store.cjs');
const { mergeExtensionConfig } = require('../vscode-host/config-sync.js');

test('VS Code host registry fields merge without granting authority over policy generations', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    auth: { mode: 'oauth' },
    permissions: { profile: 'balanced', readOnly: false, blockDangerousOperations: true, confirmBeforePush: true, allowDirectoryMutations: false },
    hostRuntime: {
      authenticationPolicyGeneration: 4,
      permissionPolicyGeneration: 6,
      focusedHostId: 'obsidian-a',
      lastInteractiveHostId: 'obsidian-a',
      lastInteractiveAt: '2026-09-10T10:00:00.000Z'
    },
    hostContexts: {
      'obsidian-a': { hostId: 'obsidian-a', focused: true, updatedAt: '2026-09-10T10:00:00.000Z' }
    },
    activeHostId: 'obsidian-a'
  };
  const candidate = structuredClone(current);
  candidate.hostRuntime.authenticationPolicyGeneration = 999;
  candidate.hostRuntime.permissionPolicyGeneration = 999;
  candidate.hostRuntime.focusedHostId = 'vscode-b';
  candidate.hostRuntime.lastInteractiveHostId = 'vscode-b';
  candidate.hostRuntime.lastInteractiveAt = '2026-09-10T10:01:00.000Z';
  candidate.hostContexts['vscode-b'] = { hostId: 'vscode-b', focused: true, updatedAt: '2026-09-10T10:01:00.000Z' };
  candidate.activeHostId = 'vscode-b';

  const merged = mergeExtensionConfig(current, candidate);
  assert.equal(merged.hostRuntime.authenticationPolicyGeneration, 4);
  assert.equal(merged.hostRuntime.permissionPolicyGeneration, 6);
  assert.equal(merged.hostRuntime.focusedHostId, 'vscode-b');
  assert.equal(merged.hostRuntime.lastInteractiveHostId, 'vscode-b');
  assert.equal(merged.activeHostId, 'vscode-b');
  assert.ok(merged.hostContexts['obsidian-a']);
  assert.ok(merged.hostContexts['vscode-b']);
});

test('timestamp-only VS Code context refresh reuses current context to avoid write amplification', () => {
  const currentContext = {
    hostId: 'vscode-a',
    focused: false,
    kind: 'editor',
    workspaceRoot: 'C:/work/a',
    capturedAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z'
  };
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    hostRuntime: {},
    hostContexts: { 'vscode-a': currentContext },
    activeHostId: 'vscode-a'
  };
  const candidate = structuredClone(current);
  candidate.hostContexts['vscode-a'].capturedAt = '2026-09-10T10:00:01.000Z';
  candidate.hostContexts['vscode-a'].updatedAt = '2026-09-10T10:00:01.000Z';

  const merged = mergeExtensionConfig(current, candidate);
  assert.equal(merged.hostContexts['vscode-a'], currentContext);
});
