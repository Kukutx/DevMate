import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../gateway/obsidian-host-capabilities.mjs';

function config(overrides = {}) {
  const root = path.resolve('/vault');
  return {
    activeWorkspaceId: 'vault',
    workspaces: [{ id: 'vault', name: 'Vault', root }],
    hostBridges: {
      obsidian: {
        url: 'http://127.0.0.1:4567',
        token: 'secret',
        updatedAt: 'now',
        workspaceId: 'vault',
        workspaceRoot: root,
        protocolVersion: 3,
        capabilities: ['status']
      }
    },
    ...overrides
  };
}

test('Obsidian bridge configuration accepts only authenticated matching loopback endpoints', () => {
  const accepted = __test.bridgeConfig(config());
  assert.deepEqual(accepted, {
    hostId: 'obsidian', url: 'http://127.0.0.1:4567', token: 'secret', updatedAt: 'now',
    workspaceId: 'vault', workspaceRoot: path.resolve('/vault'), protocolVersion: 3,
    capabilities: ['status']
  });
  assert.equal(__test.bridgeConfig(config({ hostBridges: { obsidian: { url: 'https://example.com', token: 'secret' } } })), null);
  assert.equal(__test.bridgeConfig(config({ hostBridges: { obsidian: { url: 'http://127.0.0.1:4567?token=x', token: 'secret' } } })), null);
  assert.throws(() => __test.bridgeConfig(config({
    hostBridges: { obsidian: { url: 'http://127.0.0.1:4567', token: 'secret', workspaceId: 'other', protocolVersion: 3 } }
  })), /attached to workspace other/);
});

test('selects the bridge bound to the requested Vault and rejects an omitted target across writable Vaults', () => {
  const firstRoot = path.resolve('/vault-first');
  const secondRoot = path.resolve('/vault-second');
  const multiple = {
    workspaces: [
      { id: 'first', name: 'First', root: firstRoot, mode: 'workspace-write' },
      { id: 'second', name: 'Second', root: secondRoot, mode: 'workspace-write' }
    ],
    hostBridges: {
      'obsidian-first': {
        kind: 'obsidian', hostId: 'obsidian-first', url: 'http://127.0.0.1:4567', token: 'first-token',
        updatedAt: '2026-01-01T00:00:00.000Z', workspaceId: 'first', workspaceRoot: firstRoot, protocolVersion: 3
      },
      'obsidian-second': {
        kind: 'obsidian', hostId: 'obsidian-second', url: 'http://127.0.0.1:4568', token: 'second-token',
        updatedAt: '2026-01-01T00:01:00.000Z', workspaceId: 'second', workspaceRoot: secondRoot, protocolVersion: 3
      }
    }
  };
  assert.throws(() => __test.bridgeConfig(multiple), error => error.code === 'workspace_selection_required');
  assert.deepEqual(__test.bridgeConfig(multiple, 'first'), {
    hostId: 'obsidian-first', url: 'http://127.0.0.1:4567', token: 'first-token',
    updatedAt: '2026-01-01T00:00:00.000Z', workspaceId: 'first', workspaceRoot: firstRoot,
    protocolVersion: 3, capabilities: []
  });
  assert.equal(__test.bridgeConfig(multiple, 'second').hostId, 'obsidian-second');
});

test('declares bounded search, graph, query, and transactional batch tools', () => {
  const names = __test.definitions.map(item => item.name);
  for (const name of [
    'obsidian_note_query', 'obsidian_content_search', 'obsidian_note_graph', 'obsidian_schema_audit',
    'obsidian_properties_batch_preview', 'obsidian_properties_batch_apply', 'obsidian_properties_batch_rollback'
  ]) assert.equal(names.includes(name), true, name);
  const contentSearch = __test.definitions.find(item => item.name === 'obsidian_content_search');
  const graph = __test.definitions.find(item => item.name === 'obsidian_note_graph');
  assert.equal(contentSearch.annotations.readOnlyHint, true);
  assert.equal(contentSearch.timeoutMs, 120000);
  assert.equal(graph.annotations.readOnlyHint, true);
});
