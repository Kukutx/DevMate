import assert from 'node:assert/strict';
import test from 'node:test';
import { definePlugin } from '../gateway/plugins/plugin-sdk.mjs';
import { createPluginRuntime, createPluginServiceRegistry } from '../gateway/plugins/plugin-runtime.mjs';
import { pluginMap } from '../gateway/plugins/plugin-config.mjs';

function plugin(manifest) {
  return definePlugin({ manifest, activate() {} });
}

const provider = plugin({
  id: 'devmate.provider', name: 'Provider', version: '1.0.0', apiVersion: '1',
  toolPrefixes: ['provider_'], provides: ['devmate.provider']
});
const consumer = plugin({
  id: 'devmate.consumer', name: 'Consumer', version: '1.0.0', apiVersion: '1',
  toolPrefixes: ['consumer_'], dependencies: ['devmate.provider'], consumes: ['devmate.provider']
});

test('plugin service registry enforces declared providers and consumers', () => {
  const registry = createPluginServiceRegistry();
  const provided = createPluginRuntime(provider, {}, registry).services.provide('devmate.provider', { ready: true });
  assert.equal(provided.ready, true);
  assert.equal(createPluginRuntime(consumer, {}, registry).services.get('devmate.provider').ready, true);
  assert.throws(() => createPluginRuntime(provider, {}, registry).services.get('devmate.provider'), /did not declare consumed service/);
  assert.deepEqual(registry.list(), [{ name: 'devmate.provider', pluginId: 'devmate.provider' }]);
});

test('plugin catalog validation requires consumed services to come from dependencies', () => {
  pluginMap([provider, consumer]);
  const bad = plugin({
    id: 'devmate.badconsumer', name: 'Bad Consumer', version: '1.0.0', apiVersion: '1',
    toolPrefixes: ['badconsumer_'], consumes: ['devmate.provider']
  });
  assert.throws(() => pluginMap([provider, bad]), /without declaring it as a dependency/);
});
