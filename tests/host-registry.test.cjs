'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  clearHostContext,
  pruneStaleHostContexts,
  publishHostContext,
  selectHostContext
} = require('../shared/host-registry.cjs');

test('background host context updates do not steal focused host authority', () => {
  const config = { hostRuntime: {}, hostContexts: {} };

  publishHostContext(config, 'vscode-a', {
    focused: true,
    pid: 101,
    updatedAt: '2026-09-10T10:00:00.000Z',
    workspaceRoot: 'A'
  }, { processAliveImpl: () => true });
  assert.equal(config.activeHostId, 'vscode-a');
  assert.equal(config.hostRuntime.focusedHostId, 'vscode-a');

  publishHostContext(config, 'vscode-b', {
    focused: false,
    pid: 102,
    updatedAt: '2026-09-10T10:01:00.000Z',
    workspaceRoot: 'B'
  }, { processAliveImpl: () => true });
  assert.equal(config.activeHostId, 'vscode-a');
  assert.equal(config.hostRuntime.focusedHostId, 'vscode-a');
  assert.equal(selectHostContext(config).workspaceRoot, 'A');

  publishHostContext(config, 'vscode-b', {
    focused: true,
    pid: 102,
    updatedAt: '2026-09-10T10:02:00.000Z',
    workspaceRoot: 'B'
  }, { processAliveImpl: () => true });
  assert.equal(config.activeHostId, 'vscode-b');
  assert.equal(config.hostRuntime.focusedHostId, 'vscode-b');
  assert.equal(config.hostRuntime.lastInteractiveHostId, 'vscode-b');
  assert.equal(selectHostContext(config).workspaceRoot, 'B');
});

test('focus loss is explicit and falls back without fabricating focused state', () => {
  const config = { hostRuntime: {}, hostContexts: {} };
  publishHostContext(config, 'obsidian-a', {
    focused: true,
    pid: 201,
    updatedAt: '2026-09-10T10:00:00.000Z'
  }, { processAliveImpl: () => true });

  publishHostContext(config, 'obsidian-a', {
    focused: false,
    pid: 201,
    updatedAt: '2026-09-10T10:01:00.000Z'
  }, { processAliveImpl: () => true });

  assert.equal(config.activeHostId, 'obsidian-a');
  assert.equal(config.hostRuntime.focusedHostId, undefined);
  assert.equal(selectHostContext(config).hostId, 'obsidian-a');
});

test('stale crashed hosts are pruned without removing live or current publisher contexts', () => {
  const nowMs = Date.parse('2026-09-10T12:00:00.000Z');
  const config = {
    activeHostId: 'dead-host',
    hostRuntime: { focusedHostId: 'dead-host' },
    hostContexts: {
      'dead-host': { hostId: 'dead-host', pid: 301, updatedAt: '2026-09-10T11:58:00.000Z' },
      'live-host': { hostId: 'live-host', pid: 302, updatedAt: '2026-09-10T11:57:00.000Z' },
      legacy: { hostId: 'legacy', updatedAt: '2026-09-10T11:00:00.000Z' }
    }
  };

  const result = pruneStaleHostContexts(config, {
    nowMs,
    deadHostGraceMs: 30000,
    staleHostMs: 10 * 60 * 1000,
    processAliveImpl: pid => pid === 302
  });

  assert.deepEqual(new Set(result.removed), new Set(['dead-host', 'legacy']));
  assert.deepEqual(Object.keys(config.hostContexts), ['live-host']);
  assert.equal(config.activeHostId, 'live-host');
  assert.equal(config.hostRuntime.focusedHostId, undefined);
});

test('clear removes only one host and selection falls back to another registered host', () => {
  const config = { hostRuntime: {}, hostContexts: {} };
  publishHostContext(config, 'vscode-a', { focused: false, pid: 401, updatedAt: '2026-09-10T10:00:00.000Z' }, { processAliveImpl: () => true });
  publishHostContext(config, 'obsidian-b', { focused: true, pid: 402, updatedAt: '2026-09-10T10:01:00.000Z' }, { processAliveImpl: () => true });

  clearHostContext(config, 'obsidian-b', { processAliveImpl: () => true });

  assert.equal(config.hostContexts['obsidian-b'], undefined);
  assert.ok(config.hostContexts['vscode-a']);
  assert.equal(config.activeHostId, 'vscode-a');
  assert.equal(config.hostRuntime.focusedHostId, undefined);
});

test('requested host alias resolves by persisted hostId', () => {
  const config = {
    hostContexts: {
      storageKey: { hostId: 'vscode-real-id', updatedAt: '2026-09-10T10:00:00.000Z' }
    }
  };
  assert.equal(selectHostContext(config, 'vscode-real-id').hostId, 'vscode-real-id');
});
