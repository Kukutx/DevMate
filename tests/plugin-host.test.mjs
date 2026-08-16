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

const { registerPluginHost, __test } = await import('../gateway/plugins/plugin-host.mjs');

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

test('enabling Godot also enables Browser QA and its shared service on the next server instance', async () => {
  const server = new MockServer();
  await registerPluginHost(server);
  await server.connect();
  await server.tools.get('plugin_enable').handler({ id: 'devmate.godot' });
  const next = new MockServer();
  await registerPluginHost(next);
  await next.connect();
  assert.equal(next.tools.has('godot_status'), true);
  assert.equal(next.tools.has('browser_qa_status'), true);
  assert.equal(next.tools.has('web_preview_start'), true);
  const catalog = await next.tools.get('plugin_catalog').handler({});
  assert.deepEqual(catalog.structuredContent.activeServices, [{ name: 'devmate.browser-qa', pluginId: 'devmate.browser-qa' }]);
});

test('rejects multi-plugin dependency cycles', () => {
  const map = new Map([
    ['a', { manifest: { id: 'a', dependencies: ['b'] } }],
    ['b', { manifest: { id: 'b', dependencies: ['a'] } }]
  ]);
  assert.throws(() => __test.expandDependencies(new Set(['a']), map), /dependency cycle/);
});

test.after(async () => { await fsp.rm(temp, { recursive: true, force: true }); });
