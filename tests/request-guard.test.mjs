import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-request-guard-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
const access = await import('../gateway/team-access.mjs');
const requestContextModule = await import('../gateway/request-context.mjs');
const guard = await import('../gateway/request-guard.mjs');
const config = {
  version: 11,
  auth: { required: true, token: 'owner-token-value-long-enough' },
  permissions: { profile: 'fullAccess' },
  connection: { provider: 'external', publicUrl: 'https://devmate.example.com' },
  team: { members: [], requireWorkspaceLeaseForWrites: true },
  requestPolicy: {
    requestsPerMinute: 10,
    maxConcurrentRequests: 4,
    maxConcurrentPerPrincipal: 2,
    maxRequestBytes: 100000,
    requestTimeoutMs: 10000,
    allowedHosts: ['127.0.0.1']
  },
  runtime: { maxConcurrentJobs: 2 },
  jobs: { embeddedRunnerEnabled: true, allowJobGitSave: true },
  activeWorkspaceId: 'workspace',
  workspaces: [{ id: 'workspace', root: temp }]
};
access.normalizeInstanceConfig(config);
const created = access.createTeamMember(config, {
  name: 'Alice', role: 'developer', workspaceIds: ['workspace']
});
await fsp.writeFile(configPath, JSON.stringify(config, null, 2));

let server;
let base;
test.before(async () => {
  guard.resetRequestGuardState();
  server = http.createServer(guard.guardListener((req, res) => {
    const principal = requestContextModule.requestPrincipal();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ principal, authorization: req.headers.authorization }));
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/mcp`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await fsp.rm(temp, { recursive: true, force: true });
});

test('authenticates scoped team tokens and rewrites the internal owner credential', async () => {
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${created.token}`,
      'content-type': 'application/json'
    },
    body: '{}'
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.principal.id, created.member.id);
  assert.equal(body.authorization, 'Bearer owner-token-value-long-enough');
});

test('rejects invalid tokens', async () => {
  const response = await fetch(base, {
    method: 'POST',
    headers: {
      authorization: 'Bearer invalid-token',
      'content-type': 'application/json'
    },
    body: '{}'
  });
  assert.equal(response.status, 401);
});

test('rejects oversized chunked MCP bodies without trusting Content-Length', async () => {
  guard.resetRequestGuardState();
  let bodyCompleted = false;
  const streamServer = http.createServer(guard.guardListener(async (req, res) => {
    try {
      for await (const _chunk of req) {}
      bodyCompleted = true;
    } catch {}
    if (!res.headersSent) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  }));
  await new Promise(resolve => streamServer.listen(0, '127.0.0.1', resolve));
  const port = streamServer.address().port;
  const result = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/mcp',
      method: 'POST',
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
        'transfer-encoding': 'chunked'
      }
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.write('{"payload":"');
    request.write('x'.repeat(120000));
    request.end('"}');
  });
  await new Promise(resolve => streamServer.close(resolve));
  assert.equal(result.status, 413);
  assert.equal(JSON.parse(result.body).code, 'request_too_large');
  assert.equal(bodyCompleted, false);
});

test('enforces per-principal rate limits', () => {
  guard.resetRequestGuardState();
  for (let index = 0; index < 10; index++) {
    assert.equal(guard.__test.consumeRateLimit('alice', 10).allowed, true);
  }
  assert.equal(guard.__test.consumeRateLimit('alice', 10).allowed, false);
});

test('maintains a separate authentication-attempt limiter', () => {
  guard.resetRequestGuardState();
  assert.equal(guard.__test.consumeRateLimit('ip:test', 2, guard.__test.preAuthRateWindows).allowed, true);
  assert.equal(guard.__test.consumeRateLimit('ip:test', 2, guard.__test.preAuthRateWindows).allowed, true);
  assert.equal(guard.__test.consumeRateLimit('ip:test', 2, guard.__test.preAuthRateWindows).allowed, false);
});

test('rate limits unauthenticated published preview traffic per remote address', () => {
  guard.resetRequestGuardState();
  const request = { socket: { remoteAddress: '203.0.113.10' } };
  const previewConfig = { requestPolicy: { requestsPerMinute: 10 } };
  for (let index = 0; index < 240; index += 1) {
    assert.equal(guard.__test.consumePreviewRateLimit(request, previewConfig).allowed, true);
  }
  assert.equal(guard.__test.consumePreviewRateLimit(request, previewConfig).allowed, false);
  assert.equal(guard.__test.consumePreviewRateLimit({ socket: { remoteAddress: '203.0.113.11' } }, previewConfig).allowed, true);
});

test('Host restrictions are explicit request policy rather than a deployment mode side effect', () => {
  const publicRequest = host => ({ headers: { host }, socket: { remoteAddress: '203.0.113.10' } });
  const localRequest = host => ({ headers: { host }, socket: { remoteAddress: '127.0.0.1' } });
  const unrestricted = { requestPolicy: { allowedHosts: [] } };
  assert.equal(guard.__test.hostAllowed(publicRequest('devmate.example.com'), unrestricted), true);
  assert.equal(guard.__test.hostAllowed(localRequest('127.0.0.1:8787'), unrestricted), true);
  assert.equal(guard.__test.hostAllowed(publicRequest('localhost:8787'), unrestricted), false);
  const restricted = { requestPolicy: { allowedHosts: ['devmate.example.com'] } };
  assert.equal(guard.__test.hostAllowed(publicRequest('devmate.example.com'), restricted), true);
  assert.equal(guard.__test.hostAllowed(publicRequest('evil.example.com'), restricted), false);
});
