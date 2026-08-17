import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-plugin-host-'));
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(path.join(workspace, 'project.godot'), '[application]\nconfig/name="Test"\n', 'utf8');
const config = configStore.newInstanceConfig({
  workspaceRoot: workspace,
  appVersion: configStore.DEFAULT_VERSION
});
config.permissions.profile = 'fullAccess';
config.plugins = { enabled: [], settings: {} };
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;

const { builtinPlugins } = await import('../gateway/plugins/builtins.mjs');
const { registerPluginHost, shutdownPluginServices, __test } = await import('../gateway/plugins/plugin-host.mjs');

class MockServer {
  constructor() { this.tools = new Map(); this.resources = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
  registerResource(name, uri, config, handler) { this.resources.set(name, { uri, config, handler }); }
  async connect() { return 'connected'; }
}

test('registers management and automation tools while optional plugins remain disabled', async () => {
  const server = new MockServer();
  await registerPluginHost(server);
  await server.connect();
  assert.equal(server.tools.has('plugin_catalog'), true);
  assert.equal(server.tools.has('devmate_plugins_panel'), true);
  assert.equal(server.tools.has('automation_manifest_status'), true);
  assert.equal(server.tools.has('automation_manifest_template'), true);
  assert.equal(server.tools.has('godot_status'), false);
  assert.equal(server.tools.get('plugin_catalog').config._meta['openai/widgetAccessible'], true);
  assert.equal(server.tools.get('plugin_enable').config._meta['openai/widgetAccessible'], true);
  assert.equal(server.tools.get('plugin_disable').config._meta['openai/widgetAccessible'], true);
});

test('enabling Godot persists its Browser QA dependency closure for the next explicit server registration', async () => {
  const server = new MockServer();
  await registerPluginHost(server);
  await server.connect();

  await server.tools.get('plugin_enable').handler({ id: 'devmate.godot' });

  const persisted = configStore.readConfigSnapshot(configPath);
  assert.deepEqual([...persisted.plugins.enabled].sort(), ['devmate.browser-qa', 'devmate.godot']);

  const map = __test.pluginMap(builtinPlugins);
  const enabled = __test.expandDependencies(new Set(persisted.plugins.enabled), map);
  assert.deepEqual(
    __test.activationOrder(enabled, map).map(plugin => plugin.manifest.id),
    ['devmate.browser-qa', 'devmate.godot']
  );

  const catalog = await server.tools.get('plugin_catalog').handler({});
  const byId = new Map(catalog.structuredContent.plugins.map(plugin => [plugin.id, plugin]));
  assert.equal(byId.get('devmate.browser-qa').enabled, true);
  assert.equal(byId.get('devmate.godot').enabled, true);
  assert.equal(byId.get('devmate.browser-qa').active, false, 'current server keeps its immutable registration snapshot');
  assert.equal(byId.get('devmate.godot').active, false, 'new tools activate on the next explicit server registration');
  assert.deepEqual(catalog.structuredContent.activeServices, []);
});

test('rejects multi-plugin dependency cycles', () => {
  const map = new Map([
    ['a', { manifest: { id: 'a', dependencies: ['b'] } }],
    ['b', { manifest: { id: 'b', dependencies: ['a'] } }]
  ]);
  assert.throws(() => __test.expandDependencies(new Set(['a']), map), /dependency cycle/);
});

test.after(async () => {
  await shutdownPluginServices();
  await fsp.rm(temp, { recursive: true, force: true });
});
