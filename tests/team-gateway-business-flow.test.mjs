import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

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

test('real direct no-auth MCP closes work-session, write, finish, and rollback lifecycle', async () => {
  const root = process.cwd();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-personal-e2e-'));
  const workspaceRoot = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const port = await freePort();
  await fsp.mkdir(workspaceRoot, { recursive: true });

  const config = configStore.newInstanceConfig({ workspaceRoot, port, appVersion: '3.4.4' });
  config.instanceId = `personal-e2e-${Date.now()}`;
  config.auth = { mode: 'none' };
  config.connection = { provider: 'external', publicUrl: 'https://personal-e2e.example.com' };
  config.activeWorkspaceId = 'app';
  config.workspaces[0] = {
    ...config.workspaces[0],
    id: 'app',
    name: 'Application',
    role: 'active'
  };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: root,
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });

  const rpc = (method, params) => fetchJson(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
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

    const initialized = await rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'personal-e2e', version: '1.0.0' }
    });
    assert.equal(initialized.json?.result?.serverInfo?.name, 'devmate', initialized.text);

    const started = await callTool('work_session_start', {
      workspaceId: 'app',
      title: 'Personal E2E session',
      purpose: 'verify lifecycle closure',
      ttlSeconds: 300
    });
    assertToolSuccess(started, 'work_session_start');
    const session = structured(started)?.session;
    assert.ok(session?.id);

    const written = await callTool('create_file', {
      workspaceId: 'app',
      path: 'during-session.txt',
      content: 'written in direct personal mode'
    });
    assertToolSuccess(written, 'create_file');
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'during-session.txt'), 'utf8'), 'written in direct personal mode');

    const finished = await callTool('work_session_finish', { id: session.id });
    assertToolSuccess(finished, 'work_session_finish');

    const rollback = await callTool('work_session_rollback', { workSessionId: session.id });
    assertToolSuccess(rollback, 'work_session_rollback');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'during-session.txt')), false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}, { timeout: 30000 });
