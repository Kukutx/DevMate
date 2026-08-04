import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/obsidian-host-capabilities.mjs';

test('Obsidian bridge configuration accepts only authenticated loopback endpoints', () => {
  const accepted = __test.bridgeConfig({
    hostBridges: { obsidian: { url: 'http://127.0.0.1:4567', token: 'secret', updatedAt: 'now' } }
  });
  assert.deepEqual(accepted, { url: 'http://127.0.0.1:4567', token: 'secret', updatedAt: 'now' });
  assert.equal(__test.bridgeConfig({ hostBridges: { obsidian: { url: 'https://example.com', token: 'secret' } } }), null);
  assert.equal(__test.bridgeConfig({ hostBridges: { obsidian: { url: 'http://127.0.0.1:4567?token=x', token: 'secret' } } }), null);
  assert.equal(__test.bridgeConfig({ hostBridges: { obsidian: { url: 'http://localhost:4567', token: '' } } }), null);
});
