import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-plugin-host-'));
const workspace = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(path.join(workspace, 'project.godot'), '[application]\nconfig/name="Test"\n', 'utf8');
await fsp.writeFile(configPath, `${JSON.stringify({
  permissions: { profile: 'fullAccess' },
  runtime: {},
  workspaces: [{ id: 'workspace', name: 'workspace', root: workspace, mode: 'workspace-write', reference: false }],
  activeWorkspaceId: 'workspace',
  plugins: { enabled: [], settings: {} }
}, null, 2)}\n`, 'utf8');
process.env.DEVMATE_CONFIG = configPath;

const { installPluginHost } = await import('../gateway/plugins/plugin-host.mjs');

class MockServer {
  constructor() { this.tools = new Map(); this.resources = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
  registerResource(name, uri, config, handler) { this.resources.set(name, { uri, config, handler }); }
  async connect() { return 'connected'; }
}

installPluginHost(MockServer);

test('registers management tools while optional plugins remain disabled', async () => {
  const server = new MockServer();
  await server.connect();
  assert.equal(server.tools.has('plugin_catalog'), true);
  assert.equal(server.tools.has('devmate_plugins_panel'), true);
  assert.equal(server.tools.has('godot_status'), false);
});

test('enabling Godot also enables Browser QA on the next server instance', async () => {
  const server = new MockServer();
  await server.connect();
  await server.tools.get('plugin_enable').handler({ id: 'devmate.godot' });
  const next = new MockServer();
  await next.connect();
  assert.equal(next.tools.has('godot_status'), true);
  assert.equal(next.tools.has('browser_qa_status'), true);
  assert.equal(next.tools.has('web_preview_start'), true);
});

test.after(async () => { await fsp.rm(temp, { recursive: true, force: true }); });
