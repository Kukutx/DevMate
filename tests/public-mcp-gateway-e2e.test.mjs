import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const configStore = require('../shared/config-store.cjs');
const oauthSecrets = require('../shared/oauth-secrets.cjs');
const oauthTokens = require('../shared/oauth-tokens.cjs');
const { parseJsonPayload, preflightPublicMcp } = require('../host/public-mcp.js');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function localPublicRequest(port, publicHost) {
  return async (_publicUrl, options) => new Promise(resolve => {
    const body = options.body == null ? '' : String(options.body);
    const headers = { ...(options.headers || {}), host: publicHost };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/mcp',
      method: options.method,
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          headers: response.headers || {},
          body: responseBody,
          json: parseJsonPayload(responseBody),
          bytes: Buffer.byteLength(responseBody)
        });
      });
    });
    request.on('error', error => resolve({ ok: false, error: error.message || String(error), bytes: 0 }));
    if (body) request.write(body);
    request.end();
  });
}

test('public preflight uses OAuth and MCP 2026 discovery, tools/list, and tools/call against the real Gateway', async () => {
  const root = process.cwd();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-public-preflight-'));
  const workspaceRoot = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const port = await freePort();
  const publicHost = 'devmate-public.example';
  const publicUrl = `https://${publicHost}`;
  await fsp.mkdir(workspaceRoot, { recursive: true });

  const config = configStore.newInstanceConfig({
    workspaceRoot,
    port,
    appVersion: configStore.DEFAULT_VERSION
  });
  config.auth = { mode: 'oauth' };
  config.connection.publicUrl = publicUrl;
  config.requestPolicy.allowedHosts = [publicHost];
  configStore.atomicWriteJson(configPath, config);
  oauthSecrets.ensureOAuthSecrets(configPath);
  const token = oauthTokens.preflightAccessToken(config, publicUrl, configPath);

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: root,
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    let ready = false;
    for (let index = 0; index < 60; index += 1) {
      await delay(200);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/control/health`);
        const json = await response.json();
        if (response.ok && json?.instanceId === config.instanceId) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.equal(ready, true, `Gateway did not become ready.\nstdout=${stdout}\nstderr=${stderr}`);

    const result = await preflightPublicMcp({
      publicUrl,
      token,
      clientName: 'devmate-public-e2e',
      clientVersion: configStore.DEFAULT_VERSION,
      request: localPublicRequest(port, publicHost)
    });

    assert.equal(result.server?.name, 'devmate');
    assert.ok(result.toolCount > 0);
    assert.equal(result.mcpUrl, `${publicUrl}/mcp`);
    assert.equal(result.protocolVersion, '2026-07-28');
    assert.equal(result.toolCallVerified, true);
    assert.equal(result.probeTool, 'gateway_status');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}, { timeout: 30000 });
