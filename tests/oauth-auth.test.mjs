import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import configStore from '../shared/config-store.cjs';
import oauthSecrets from '../shared/oauth-secrets.cjs';
import oauthTokens from '../shared/oauth-tokens.cjs';

const MCP_PROTOCOL_VERSION = '2026-07-28';

function freePort() {
  return 19000 + Math.floor(Math.random() * 5000);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForGateway(port, child, output) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OAuth Gateway exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`OAuth Gateway did not become ready: ${output()}`);
}

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'devmate-oauth-test', version: configStore.DEFAULT_VERSION },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

function mcpBody(id, method, params = {}) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: requestMeta() }
  });
}

function mcpHeaders(method, token = '', name = '') {
  return {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    'mcp-method': method,
    ...(name ? { 'mcp-name': name } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

function publicGatewayRequest(port, publicHost, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body == null ? '' : String(options.body);
    const headers = { ...(options.headers || {}), host: publicHost };
    if (body && headers['content-length'] === undefined) headers['content-length'] = Buffer.byteLength(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode || 0,
          headers: { get: name => response.headers[String(name).toLowerCase()]?.toString() || null },
          text: async () => raw,
          json: async () => JSON.parse(raw)
        });
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

test('OAuth Gateway keeps secrets out of config, publishes current metadata, rejects DCR, and enforces bound MCP 2026 access tokens', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-oauth-gateway-'));
  const port = freePort();
  const publicHost = `oauth-${port}.devmate.test`;
  const origin = `https://${publicHost}`;
  const audience = `${origin}/mcp`;
  const configPath = path.join(directory, 'config.json');
  const config = configStore.newInstanceConfig({ workspaceRoot: process.cwd(), port, appVersion: configStore.DEFAULT_VERSION });
  config.auth = { mode: 'oauth' };
  config.connection.publicUrl = origin;
  config.requestPolicy.allowedHosts = [publicHost];
  configStore.atomicWriteJson(configPath, config);
  const secrets = oauthSecrets.ensureOAuthSecrets(configPath);

  const persistedConfig = fs.readFileSync(configPath, 'utf8');
  assert.equal(persistedConfig.includes(secrets.signingKey), false);
  assert.equal(persistedConfig.includes(secrets.ownerApprovalCode), false);
  assert.deepEqual(JSON.parse(persistedConfig).auth, { mode: 'oauth' });
  assert.equal(fs.existsSync(oauthSecrets.oauthSecretsPath(configPath)), true);

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForGateway(port, child, () => output);

  const protectedMetadata = await publicGatewayRequest(port, publicHost, '/.well-known/oauth-protected-resource/mcp');
  assert.equal(protectedMetadata.status, 200);
  const resource = await protectedMetadata.json();
  assert.equal(resource.resource, audience);
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.deepEqual(resource.bearer_methods_supported, ['header']);

  const authorizationMetadata = await publicGatewayRequest(port, publicHost, '/.well-known/oauth-authorization-server');
  assert.equal(authorizationMetadata.status, 200);
  const authorization = await authorizationMetadata.json();
  assert.equal(authorization.issuer, origin);
  assert.equal(authorization.authorization_endpoint, `${origin}/oauth/authorize`);
  assert.equal(authorization.token_endpoint, `${origin}/oauth/token`);
  assert.equal(authorization.revocation_endpoint, `${origin}/oauth/revoke`);
  assert.equal(authorization.client_id_metadata_document_supported, true);
  assert.deepEqual(authorization.code_challenge_methods_supported, ['S256']);

  const retiredDcr = await publicGatewayRequest(port, publicHost, '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:43123/callback'] })
  });
  assert.equal(retiredDcr.status, 404);

  const unauthenticated = await publicGatewayRequest(port, publicHost, '/mcp', {
    method: 'POST',
    headers: mcpHeaders('server/discover'),
    body: mcpBody(1, 'server/discover')
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get('www-authenticate') || '', /resource_metadata=/);

  const accessToken = oauthTokens.issueAccessToken(secrets.signingKey, {
    audience,
    issuer: origin,
    scope: 'devmate',
    subject: 'owner',
    ttlSeconds: 600
  });
  const discovery = await publicGatewayRequest(port, publicHost, '/mcp', {
    method: 'POST',
    headers: mcpHeaders('server/discover', accessToken),
    body: mcpBody(2, 'server/discover')
  });
  assert.equal(discovery.status, 200);
  const discovered = await discovery.json();
  assert.ok(discovered.result?.supportedVersions?.includes(MCP_PROTOCOL_VERSION));
  assert.equal(typeof discovered.result?.capabilities, 'object');

  const statusCall = await publicGatewayRequest(port, publicHost, '/mcp', {
    method: 'POST',
    headers: mcpHeaders('tools/call', accessToken, 'gateway_status'),
    body: mcpBody(3, 'tools/call', { name: 'gateway_status', arguments: {} })
  });
  assert.equal(statusCall.status, 200);
  const statusResult = await statusCall.json();
  assert.equal(statusResult.result?.isError, undefined);
  assert.equal(statusResult.result?.structuredContent?.name, 'devmate');

  const wrongIssuer = oauthTokens.issueAccessToken(secrets.signingKey, {
    audience,
    issuer: 'https://other-issuer.example',
    scope: 'devmate',
    subject: 'owner'
  });
  const rejectedIssuer = await publicGatewayRequest(port, publicHost, '/mcp', {
    method: 'POST',
    headers: mcpHeaders('server/discover', wrongIssuer),
    body: mcpBody(4, 'server/discover')
  });
  assert.equal(rejectedIssuer.status, 401);

  const wrongAudience = oauthTokens.issueAccessToken(secrets.signingKey, {
    audience: `${origin}/other-resource`,
    issuer: origin,
    scope: 'devmate',
    subject: 'owner'
  });
  const rejectedAudience = await publicGatewayRequest(port, publicHost, '/mcp', {
    method: 'POST',
    headers: mcpHeaders('server/discover', wrongAudience),
    body: mcpBody(5, 'server/discover')
  });
  assert.equal(rejectedAudience.status, 401);
});

test('CIMD policy is HTTPS-only, metadata-bound, redirect-safe, and rejects non-public metadata addresses', async () => {
  const previous = process.env.DEVMATE_CONFIG;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-oauth-cimd-'));
  const configPath = path.join(directory, 'config.json');
  const config = configStore.newInstanceConfig({ workspaceRoot: process.cwd(), port: freePort(), appVersion: configStore.DEFAULT_VERSION });
  config.auth = { mode: 'oauth' };
  configStore.atomicWriteJson(configPath, config);
  oauthSecrets.ensureOAuthSecrets(configPath);
  process.env.DEVMATE_CONFIG = configPath;
  const { __test } = await import(`../gateway/oauth.mjs?oauth-cimd=${Date.now()}`);
  try {
    const clientId = 'https://client.example/oauth/client-metadata.json';
    assert.equal(__test.cimdUrl(clientId).toString(), clientId);
    assert.throws(() => __test.cimdUrl('http://client.example/metadata.json'), /clean HTTPS/);
    assert.throws(() => __test.cimdUrl('https://user:pass@client.example/metadata.json'), /clean HTTPS/);
    assert.deepEqual(__test.validateClientMetadata({
      client_id: clientId,
      client_name: 'Current MCP Client',
      redirect_uris: ['http://127.0.0.1:43123/callback', 'https://client.example/callback'],
      token_endpoint_auth_method: 'none',
      response_types: ['code'],
      grant_types: ['authorization_code']
    }, clientId), {
      client_id: clientId,
      client_name: 'Current MCP Client',
      redirect_uris: ['http://127.0.0.1:43123/callback', 'https://client.example/callback']
    });
    assert.throws(() => __test.validateClientMetadata({
      client_id: 'https://other.example/metadata.json',
      client_name: 'Mismatch',
      redirect_uris: ['https://client.example/callback']
    }, clientId), /does not match/);
    assert.throws(() => __test.validateClientMetadata({
      client_id: clientId,
      client_name: 'Unsafe redirect',
      redirect_uris: ['http://public.example/callback']
    }, clientId), /unsafe redirect URI/);
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.1.1', '192.168.1.10', '::1', 'fc00::1', '2001:db8::1']) {
      assert.equal(__test.publicAddress(address), false, `${address} must not be a CIMD destination`);
    }
    assert.equal(__test.publicAddress('8.8.8.8'), true);
  } finally {
    if (previous === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('owner approval code rotation is one-time and never mutates the public config document', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-oauth-secret-'));
  try {
    const configPath = path.join(directory, 'config.json');
    const config = configStore.newInstanceConfig({ workspaceRoot: process.cwd(), port: freePort(), appVersion: configStore.DEFAULT_VERSION });
    config.auth = { mode: 'oauth' };
    configStore.atomicWriteJson(configPath, config);
    const first = oauthSecrets.ensureOAuthSecrets(configPath);
    const before = fs.readFileSync(configPath, 'utf8');
    const second = oauthSecrets.rotateOwnerApprovalCode(configPath, first.ownerApprovalCode);
    assert.notEqual(second.ownerApprovalCode, first.ownerApprovalCode);
    assert.equal(second.generation, first.generation + 1);
    assert.throws(
      () => oauthSecrets.rotateOwnerApprovalCode(configPath, first.ownerApprovalCode),
      error => error?.code === 'oauth_approval_code_stale'
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), before);
    assert.equal(before.includes(first.ownerApprovalCode), false);
    assert.equal(before.includes(first.signingKey), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
