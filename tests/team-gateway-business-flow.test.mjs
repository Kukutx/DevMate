import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const MCP_PROTOCOL_VERSION = '2026-07-28';

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function structured(result) {
  return result.json?.result?.structuredContent || null;
}

function assertToolSuccess(result, label) {
  assert.equal(result.response.ok, true, `${label} HTTP failed: ${result.text}`);
  assert.equal(!!result.json?.error, false, `${label} RPC failed: ${result.text}`);
  assert.notEqual(result.json?.result?.isError, true, `${label} tool failed: ${result.text}`);
}

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'personal-e2e', version: configStore.DEFAULT_VERSION },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

test('real loopback no-auth MCP closes work-session, write, finish, and rollback lifecycle', async () => {
  const root = process.cwd();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-personal-e2e-'));
  const workspaceRoot = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const port = await freePort();
  await fsp.mkdir(workspaceRoot, { recursive: true });

  const config = configStore.newInstanceConfig({ workspaceRoot, port, appVersion: configStore.DEFAULT_VERSION });
  config.instanceId = `personal-e2e-${Date.now()}`;
  config.auth = { mode: 'none' };
  config.connection = { provider: 'ngrok', publicUrl: '' };
  config.activeWorkspaceId = 'app';
  config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'Application', role: 'active' };
  configStore.atomicWriteJson(configPath, config);

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: root,
    env: { ...process.env, DEVMATE_CONFIG: configPath, DEVMATE_DESKTOP_LIFECYCLE_FENCE: '0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  let requestId = 0;
  const rpc = (method, params = {}) => {
    const name = method === 'tools/call' ? String(params?.name || '') : '';
    return fetchJson(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params: { ...params, _meta: requestMeta() } })
    });
  };
  const callTool = (name, args) => rpc('tools/call', { name, arguments: args });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await delay(200);
      try {
        const health = await fetchJson(`http://127.0.0.1:${port}/control/health`);
        if (health.response.ok && health.json?.instanceId === config.instanceId) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.equal(ready, true, `Gateway not ready: ${output}`);

    const discovery = await rpc('server/discover');
    assert.equal(discovery.response.ok, true, discovery.text);
    assert.ok(discovery.json?.result?.supportedVersions?.includes(MCP_PROTOCOL_VERSION), discovery.text);

    const started = await callTool('work_session_start', {
      workspaceId: 'app', title: 'Personal E2E session', purpose: 'verify lifecycle closure', ttlSeconds: 300
    });
    assertToolSuccess(started, 'work_session_start');
    const session = structured(started)?.session;
    assert.ok(session?.id);

    const written = await callTool('create_file', {
      workspaceId: 'app', path: 'during-session.txt', content: 'written in direct personal mode'
    });
    assertToolSuccess(written, 'create_file');
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'during-session.txt'), 'utf8'), 'written in direct personal mode');

    const finished = await callTool('work_session_finish', { id: session.id });
    assertToolSuccess(finished, 'work_session_finish');

    const rollback = await callTool('work_session_rollback', { workSessionId: session.id });
    assertToolSuccess(rollback, 'work_session_rollback');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'during-session.txt')), false);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await Promise.race([exited, delay(3000)]);
    await fsp.rm(temp, { recursive: true, force: true });
  }
}, { timeout: 30000 });
