import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, validatePluginManifest } from '../runtime/engines/plugin-sdk.mjs';

test('an engine manifest holds identity, an owner-only declaration and executable patterns', () => {
  const manifest = validatePluginManifest({
    id: 'devmate.example', name: 'Example', version: '1.2.3', description: ' Example engine. ',
    ownerOnly: true, permissions: { executablePatterns: ['^example(?:\\.exe)?$', '^example(?:\\.exe)?$'] }
  });
  assert.deepEqual(manifest, {
    id: 'devmate.example', name: 'Example', version: '1.2.3', description: 'Example engine.',
    ownerOnly: true, permissions: { executablePatterns: ['^example(?:\\.exe)?$'] }
  });
  assert.equal(validatePluginManifest({ id: 'devmate.plain', name: 'Plain', version: '1.0.0' }).ownerOnly, false);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.permissions));
});

test('fields the capability registry never reads are rejected instead of carried along', () => {
  for (const field of ['apiVersion', 'toolPrefixes', 'defaultEnabled', 'dependencies', 'provides', 'consumes', 'capabilities', 'core']) {
    assert.throws(() => validatePluginManifest({ id: 'devmate.example', name: 'Example', version: '1.0.0', [field]: [] }),
      new RegExp('unsupported fields: ' + field), field);
  }
  assert.throws(() => validatePluginManifest({ id: 'devmate.example', name: 'Example', version: '1.0.0', permissions: { secretSettingKeys: ['x'] } }), /only declare executablePatterns/);
});

test('rejects malformed identity, versions and executable patterns', () => {
  assert.throws(() => validatePluginManifest({ id: 'Bad Id', name: 'Bad', version: '1.0.0' }), /Invalid engine id/);
  assert.throws(() => validatePluginManifest({ id: 'devmate.bad', version: '1.0.0' }), /missing name/);
  assert.throws(() => validatePluginManifest({ id: 'devmate.bad', name: 'Bad', version: 'one' }), /invalid version/);
  assert.throws(() => validatePluginManifest({ id: 'devmate.bad', name: 'Bad', version: '1.0.0', permissions: { executablePatterns: ['('] } }), /invalid executable pattern/);
  assert.throws(() => validatePluginManifest({ id: 'devmate.bad', name: 'Bad', version: '1.0.0', permissions: { executablePatterns: 'godot' } }), /array of non-empty strings/);
});

test('an engine needs an activate function and object default settings', () => {
  const manifest = { id: 'devmate.example', name: 'Example', version: '1.0.0' };
  assert.throws(() => definePlugin({ manifest }), /must provide activate/);
  assert.throws(() => definePlugin({ manifest, activate() {}, diagnose: 'status' }), /diagnose must be a function/);
  assert.throws(() => definePlugin({ manifest, activate() {}, defaultSettings: [] }), /defaultSettings must be an object/);
  const engine = definePlugin({ manifest, activate() {}, defaultSettings: { value: 1 } });
  assert.deepEqual(engine.defaultSettings, { value: 1 });
  assert.ok(Object.isFrozen(engine) && Object.isFrozen(engine.defaultSettings));
});
