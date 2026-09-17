import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(root, 'gateway', 'server.bundle.mjs');
const protocol = '2026-07-28';

test('bundled Gateway exposes and executes reverse tools over real MCP HTTP', { timeout: 45000 }, async t => {
  assert.equal(fs.existsSync(bundle), true, 'Build the Gateway before running the transport integration test');
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-http-'));
  const workspace = path.join(temp, 'workspace');
  await fsp.mkdir(workspace);
  await fsp.writeFile(path.join(workspace, 'fixture.bin'), Buffer.from('64000000c800000064000000', 'hex'));
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const config = configStore.newInstanceConfig({ workspaceRoot: workspace, port, appVersion: configStore.DEFAULT_VERSION });
  config.auth = { mode: 'none' };
  config.permissions.profile = 'fullAccess';
  config.plugins = { enabled: [], settings: {} };
  const configPath = path.join(temp, 'config.json');
  configStore.atomicWriteJson(configPath, config);
  const child = spawn(process.execPath, [bundle], { cwd: root, env: { ...process.env, DEVMATE_CONFIG: configPath, DEVMATE_DESKTOP_LIFECYCLE_FENCE: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data.toString()).slice(-16000); });
  child.on('error', error => { logs += error.message; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    await fsp.rm(temp, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/control/health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (response.ok && health.instanceId === config.instanceId) { ready = true; break; }
    } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  assert.equal(ready, true, logs);
  let requestId = 0;
  const rpc = async (method, params = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, 'mcp-method': method, ...(params.name ? { 'mcp-name': params.name } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: { ...params, _meta: {
        'io.modelcontextprotocol/protocolVersion': protocol,
        'io.modelcontextprotocol/clientInfo': { name: 'reverse-transport-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      } } })
    });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    const body = JSON.parse(text);
    assert.equal(body.error, undefined, text);
    return body.result;
  };
  const call = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: { workspaceId: config.activeWorkspaceId, ...args } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent;
  };
  const initial = await rpc('tools/list');
  assert.equal(initial.tools.some(item => item.name.startsWith('reverse_')), false);
  const enabled = await rpc('tools/call', { name: 'plugin_enable', arguments: { id: 'devmate.reverse' } });
  assert.notEqual(enabled.isError, true, JSON.stringify(enabled));
  const listed = await rpc('tools/list');
  assert.equal(listed.tools.filter(item => item.name.startsWith('reverse_')).length, 29);
  const status = await call('reverse_status');
  assert.equal(status.processAccessEnabled, false);
  const info = await call('reverse_binary_info', { path: 'fixture.bin' });
  assert.equal(info.size, 12); assert.equal(info.format, 'raw');
  assert.match(info.sha256, /^[a-f0-9]{64}$/);
  const search = await call('reverse_bytes_search', { path: 'fixture.bin', value: 100, dataType: 'int32' });
  assert.deepEqual(search.matches, [0, 8]);
  const codec = await call('reverse_value_codec', { dataType: 'uint64', value: '18446744073709551615' });
  assert.equal(codec.hex, 'ffffffffffffffff');
  const denied = await rpc('tools/call', { name: 'reverse_processes', arguments: { workspaceId: config.activeWorkspaceId } });
  assert.equal(denied.isError, true);
  const disabled = await rpc('tools/call', { name: 'plugin_disable', arguments: { id: 'devmate.reverse' } });
  assert.notEqual(disabled.isError, true, JSON.stringify(disabled));
  assert.equal((await rpc('tools/list')).tools.some(item => item.name.startsWith('reverse_')), false);
});
