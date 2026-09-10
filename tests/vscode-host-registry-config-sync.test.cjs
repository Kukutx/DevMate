'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION } = require('../shared/config-store.cjs');
const { publishHostContext } = require('../shared/host-registry.cjs');
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
      'obsidian-a': { hostId: 'obsidian-a', focused: true, pid: 1001, updatedAt: '2026-09-10T10:00:00.000Z' }
    },
    activeHostId: 'obsidian-a'
  };
  const candidate = structuredClone(current);
  candidate.hostRuntime.authenticationPolicyGeneration = 999;
  candidate.hostRuntime.permissionPolicyGeneration = 999;
  publishHostContext(candidate, 'vscode-b', {
    focused: true,
    pid: 1002,
    updatedAt: '2026-09-10T10:01:00.000Z'
  }, {
    nowMs: Date.parse('2026-09-10T10:01:00.000Z'),
    processAliveImpl: () => true
  });

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

test('one VS Code writer cannot replay stale context or focus over a newer host', () => {
  const base = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    hostRuntime: { focusedHostId: 'vscode-a' },
    hostContexts: {
      'vscode-a': { hostId: 'vscode-a', focused: true, pid: 2001, updatedAt: '2026-09-10T10:00:00.000Z', activeEditor: { path: 'old-a.js' } },
      'obsidian-b': { hostId: 'obsidian-b', focused: false, pid: 2002, updatedAt: '2026-09-10T10:00:00.000Z', activeDocument: { path: 'Old.md' } }
    },
    activeHostId: 'vscode-a'
  };

  const candidate = structuredClone(base);
  publishHostContext(candidate, 'vscode-a', {
    focused: false,
    pid: 2001,
    updatedAt: '2026-09-10T10:02:00.000Z',
    activeEditor: { path: 'new-a.js' }
  }, {
    nowMs: Date.parse('2026-09-10T10:02:00.000Z'),
    processAliveImpl: () => true
  });

  const current = structuredClone(base);
  current.hostContexts['obsidian-b'] = {
    hostId: 'obsidian-b',
    focused: true,
    pid: 2002,
    updatedAt: '2026-09-10T10:03:00.000Z',
    activeDocument: { path: 'Current.md' }
  };
  current.hostRuntime = {
    focusedHostId: 'obsidian-b',
    lastInteractiveHostId: 'obsidian-b',
    lastInteractiveAt: '2026-09-10T10:03:00.000Z'
  };
  current.activeHostId = 'obsidian-b';

  const merged = mergeExtensionConfig(current, candidate);
  assert.equal(merged.hostContexts['vscode-a'].activeEditor.path, 'new-a.js');
  assert.equal(merged.hostContexts['obsidian-b'].activeDocument.path, 'Current.md');
  assert.equal(merged.hostRuntime.focusedHostId, 'obsidian-b');
  assert.equal(merged.hostRuntime.lastInteractiveHostId, 'obsidian-b');
  assert.equal(merged.activeHostId, 'obsidian-b');
});
