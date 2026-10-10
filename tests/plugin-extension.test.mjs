import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, extendPlugin } from '../runtime/engines/plugin-sdk.mjs';

function baseEngine(events) {
  return definePlugin({
    manifest: {
      id: 'devmate.example',
      name: 'Example',
      version: '1.0.0',
      description: 'Base engine.',
      ownerOnly: true,
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

test('composes engine lifecycle without duplicating base activation', async () => {
  const events = [];
  const base = baseEngine(events);
  const extended = extendPlugin(base, {
    version: '1.1.0',
    description: 'Extended engine.',
    defaultSettings: { extra: true },
    executablePatterns: ['^helper$'],
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
  assert.deepEqual(extended.defaultSettings, { base: true, extra: true });
});

test('an extension keeps the identity and owner-only declaration of its base', () => {
  const base = baseEngine([]);
  const extended = extendPlugin(base, { version: '1.1.0', executablePatterns: ['^helper$'] });
  assert.equal(extended.manifest.id, base.manifest.id);
  assert.equal(extended.manifest.name, base.manifest.name);
  assert.equal(extended.manifest.version, '1.1.0');
  assert.equal(extended.manifest.description, 'Base engine.');
  assert.equal(extended.manifest.ownerOnly, true);
  assert.deepEqual(extended.manifest.permissions.executablePatterns, ['^example$', '^helper$']);
  assert.throws(() => extendPlugin(base, {}), /requires version/);
  assert.throws(() => extendPlugin(base, { version: '1.1.0', activate: 'now' }), /activate must be a function/);
  assert.throws(() => extendPlugin({}, { version: '1.1.0' }), /valid base engine/);
});
