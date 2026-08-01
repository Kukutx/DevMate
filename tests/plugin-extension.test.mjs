import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, extendPlugin } from '../gateway/plugins/plugin-sdk.mjs';

function basePlugin(events) {
  return definePlugin({
    manifest: {
      id: 'devmate.example',
      name: 'Example',
      version: '1.0.0',
      apiVersion: '1',
      description: 'Base plugin.',
      defaultEnabled: false,
      dependencies: [],
      toolPrefixes: ['example_'],
      capabilities: ['base'],
      provides: [],
      consumes: [],
      permissions: { executablePatterns: ['^example$'] }
    },
    defaultSettings: { base: true },
    async activate() { events.push('base:activate'); },
    async diagnose() {
      events.push('base:diagnose');
      return { base: true };
    },
    async deactivate() { events.push('base:deactivate'); }
  });
}

test('composes plugin lifecycle and manifest without duplicating base activation', async () => {
  const events = [];
  const base = basePlugin(events);
  const extended = extendPlugin(base, {
    version: '1.1.0',
    description: 'Extended plugin.',
    capabilities: ['extra', 'base'],
    defaultSettings: { extra: true },
    async activate() { events.push('extension:activate'); },
    async diagnose(_context, baseResult) {
      events.push('extension:diagnose');
      return { ...baseResult, extra: true };
    },
    async deactivate() { events.push('extension:deactivate'); }
  });

  await extended.activate({});
  assert.deepEqual(events, ['base:activate', 'extension:activate']);
  assert.deepEqual(await extended.diagnose({}), { base: true, extra: true });
  await extended.deactivate({});
  assert.deepEqual(events, [
    'base:activate', 'extension:activate',
    'base:diagnose', 'extension:diagnose',
    'extension:deactivate', 'base:deactivate'
  ]);
  assert.equal(extended.manifest.id, base.manifest.id);
  assert.equal(extended.manifest.version, '1.1.0');
  assert.deepEqual(extended.manifest.capabilities, ['base', 'extra']);
  assert.deepEqual(extended.defaultSettings, { base: true, extra: true });
});

test('rejects plugin extensions that change identity or API version', () => {
  const base = basePlugin([]);
  assert.throws(() => extendPlugin(base, {
    version: '1.1.0',
    manifest: { id: 'devmate.other' }
  }), /cannot change id/);
  assert.throws(() => extendPlugin(base, {
    version: '1.1.0',
    manifest: { apiVersion: '2' }
  }), /cannot change API version/);
});
