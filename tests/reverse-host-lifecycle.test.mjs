import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-host-'));
const root = path.join(temp, 'workspace');
await fsp.mkdir(root);
const configPath = path.join(temp, 'config.json');
const config = configStore.newInstanceConfig({ workspaceRoot: root, appVersion: configStore.DEFAULT_VERSION });
config.permissions.profile = 'fullAccess';
config.plugins = { enabled: ['devmate.reverse'], settings: {} };
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;

const { registerPluginHost, shutdownPluginServices } = await import('../gateway/plugins/plugin-host.mjs');
const { reversePlugin } = await import('../gateway/plugins/reverse.mjs');
const { reverseSessions } = await import('../gateway/plugins/reverse-sessions.mjs');
const { definePlugin } = await import('../gateway/plugins/plugin-sdk.mjs');

class MockServer {
  tools = new Map();
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
  registerResource() {}
}

const workspace = { id: 'fixture', root };

test('host disable clears real reverse session state and fences stale registered handlers', async () => {
  const server = new MockServer();
  await registerPluginHost(server, [reversePlugin]);
  assert.ok(server.tools.has('reverse_status'));
  reverseSessions.create(workspace, { pid: 10 });
  const result = await server.tools.get('plugin_disable').handler({ id: 'devmate.reverse' });
  assert.equal(result.structuredContent.disabled, 'devmate.reverse');
  assert.equal(reverseSessions.entries.size, 0);
  await assert.rejects(server.tools.get('reverse_status').handler({}), /disabled/);
  const next = new MockServer();
  await registerPluginHost(next, [reversePlugin]);
  assert.equal(next.tools.has('reverse_status'), false);
});

test('re-enable registers tools in a fresh server and global shutdown clears state', async () => {
  const server = new MockServer();
  await registerPluginHost(server, [reversePlugin]);
  await server.tools.get('plugin_enable').handler({ id: 'devmate.reverse' });
  const fresh = new MockServer();
  await registerPluginHost(fresh, [reversePlugin]);
  assert.ok(fresh.tools.has('reverse_value_scan'));
  reverseSessions.create(workspace, { pid: 11 });
  await shutdownPluginServices();
  assert.equal(reverseSessions.entries.size, 0);
  await shutdownPluginServices();
});

test('deactivation is once per plugin, not once per request, and concurrent shutdown is shared', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const plugin = definePlugin({
    manifest: { id: 'devmate.lifecycle-test', name: 'Lifecycle fixture', version: '0.1.0', apiVersion: '1', core: true },
    activate() {},
    async deactivate() { calls++; await gate; }
  });
  for (let i = 0; i < 25; i++) await registerPluginHost(new MockServer(), [plugin]);
  const first = shutdownPluginServices(), second = shutdownPluginServices();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second]);
  await shutdownPluginServices();
  assert.equal(calls, 1);
});

test('one failing hook does not prevent other plugin cleanup', async () => {
  let cleaned = false;
  const plugin = (id, deactivate) => definePlugin({
    manifest: { id, name: id, version: '0.1.0', apiVersion: '1', core: true }, activate() {}, deactivate
  });
  await registerPluginHost(new MockServer(), [
    plugin('devmate.lifecycle-fail', async () => { throw new Error('fixture cleanup failure'); }),
    plugin('devmate.lifecycle-ok', async () => { cleaned = true; })
  ]);
  await assert.rejects(shutdownPluginServices(), /shutdown failed/);
  assert.equal(cleaned, true);
});

test.after(async () => { await shutdownPluginServices(); await fsp.rm(temp, { recursive: true, force: true }); });
