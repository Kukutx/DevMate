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
        protocolVersion: 2,
        capabilities: ['status']
      }
    },
    ...overrides
  };
}

test('Obsidian bridge configuration accepts only authenticated matching loopback endpoints', () => {
  const accepted = __test.bridgeConfig(config());
  assert.deepEqual(accepted, {
    url: 'http://127.0.0.1:4567', token: 'secret', updatedAt: 'now',
    workspaceId: 'vault', workspaceRoot: path.resolve('/vault'), protocolVersion: 2,
    capabilities: ['status']
  });
  assert.equal(__test.bridgeConfig(config({ hostBridges: { obsidian: { url: 'https://example.com', token: 'secret' } } })), null);
  assert.equal(__test.bridgeConfig(config({ hostBridges: { obsidian: { url: 'http://127.0.0.1:4567?token=x', token: 'secret' } } })), null);
  assert.throws(() => __test.bridgeConfig(config({
    hostBridges: { obsidian: { url: 'http://127.0.0.1:4567', token: 'secret', workspaceId: 'other', protocolVersion: 2 } }
  })), /attached to workspace other/);
});

test('declares bounded query and transactional batch tools', () => {
  const names = __test.definitions.map(item => item.name);
  for (const name of [
    'obsidian_note_query', 'obsidian_schema_audit', 'obsidian_properties_batch_preview',
    'obsidian_properties_batch_apply', 'obsidian_properties_batch_rollback'
  ]) assert.equal(names.includes(name), true, name);
  const query = __test.definitions.find(item => item.name === 'obsidian_note_query');
  assert.equal(query.annotations.readOnlyHint, true);
});
