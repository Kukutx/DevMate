import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin, toolNameAllowed, validatePluginManifest } from '../gateway/plugins/plugin-sdk.mjs';

test('validates a future-safe optional plugin manifest', () => {
  const manifest = validatePluginManifest({
    id: 'devmate.example', name: 'Example', version: '1.2.3', apiVersion: '1',
    toolPrefixes: ['example_'], dependencies: [], capabilities: ['tools'],
    provides: ['devmate.example'], consumes: [], permissions: {}
  });
  assert.equal(manifest.id, 'devmate.example');
  assert.equal(toolNameAllowed(manifest, 'example_status'), true);
  assert.equal(toolNameAllowed(manifest, 'godot_status'), false);
  assert.deepEqual(manifest.provides, ['devmate.example']);
});

test('rejects optional plugins without a tool namespace', () => {
  assert.throws(() => definePlugin({
    manifest: { id: 'devmate.bad', name: 'Bad', version: '1.0.0', apiVersion: '1' },
    activate() {}
  }), /tool prefix/);
});

test('rejects dependency cycles at manifest self-reference', () => {
  assert.throws(() => validatePluginManifest({
    id: 'devmate.loop', name: 'Loop', version: '1.0.0', apiVersion: '1',
    dependencies: ['devmate.loop'], toolPrefixes: ['loop_']
  }), /depend on itself/);
});

test('rejects service providers outside their plugin namespace', () => {
  assert.throws(() => validatePluginManifest({
    id: 'devmate.example', name: 'Example', version: '1.0.0', apiVersion: '1',
    toolPrefixes: ['example_'], provides: ['devmate.other']
  }), /own service namespace/);
});
