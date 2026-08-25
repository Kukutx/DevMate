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

function localPublicRequest(port, publicHost, onRequest = () => {}) {
  return async (_publicUrl, options) => new Promise(resolve => {
    onRequest(options);
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

function authorizationHeader(headers = {}) {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization');
  return entry?.[1] == null ? '' : String(entry[1]);
}

async function runRealPublicPreflight(mode) {
  const root = process.cwd();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), `devmate-public-${mode}-`));
  const workspaceRoot = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const port = await freePort();
  const publicHost = `devmate-${mode}.example`;
  const publicUrl = `https://${publicHost}`;
  await fsp.mkdir(workspaceRoot, { recursive: true });

  const config = configStore.newInstanceConfig({
    workspaceRoot,
    port,
    appVersion: configStore.DEFAULT_VERSION
  });
  config.auth = { mode };
  config.connection.publicUrl = publicUrl;
  config.requestPolicy.allowedHosts = [publicHost];
  configStore.atomicWriteJson(configPath, config);

  let token = '';
  if (mode === 'oauth') {
    oauthSecrets.ensureOAuthSecrets(configPath);
    token = oauthTokens.preflightAccessToken(config, publicUrl, configPath);
  }

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
  const authorizationHeaders = [];

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

    try {
      const result = await preflightPublicMcp({
        publicUrl,
        token,
        clientName: `devmate-public-${mode}-e2e`,
        clientVersion: configStore.DEFAULT_VERSION,
        request: localPublicRequest(port, publicHost, options => {
          authorizationHeaders.push(authorizationHeader(options.headers));
        })
      });

      assert.equal(result.server?.name, 'devmate');
      assert.ok(result.toolCount > 0);
      assert.equal(result.mcpUrl, `${publicUrl}/mcp`);
      assert.equal(result.protocolVersion, '2026-07-28');
      assert.equal(result.toolCallVerified, true);
      assert.equal(result.probeTool, 'gateway_status');
      return { authorizationHeaders, token, rejected: false };
    } catch (error) {
      if (mode !== 'none') throw error;
      assert.equal(error?.response?.status, 401);
      assert.equal(error?.response?.json?.code, 'unauthorized');
      return { authorizationHeaders, token, rejected: true };
    }
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}

test('public single-owner no-auth MCP works against the real Gateway without Authorization', async () => {
  const result = await runRealPublicPreflight('none');
  assert.equal(result.rejected, false);
  assert.equal(result.token, '');
  assert.ok(result.authorizationHeaders.length >= 3);
  assert.deepEqual([...new Set(result.authorizationHeaders)], ['']);
}, { timeout: 30000 });

test('public OAuth works against the real Gateway', async () => {
  const result = await runRealPublicPreflight('oauth');
  assert.equal(result.rejected, false);
  assert.match(result.token, /^dmoa\./);
  assert.ok(result.authorizationHeaders.length >= 3);
  assert.ok(result.authorizationHeaders.every(value => /^Bearer\s+dmoa\./.test(value)));
}, { timeout: 30000 });
