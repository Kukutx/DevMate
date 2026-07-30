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
  auth: { required: true, token: 'owner-token-value-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: {
    mode: 'team',
    tunnelProvider: 'external',
    publicUrl: 'https://devmate.example.com'
  },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: true },
  production: {
    requestsPerMinute: 10,
    maxConcurrentRequests: 4,
    maxConcurrentPerPrincipal: 2,
    maxRequestBytes: 100000,
    requestTimeoutMs: 10000,
    allowedHosts: ['127.0.0.1']
  },
  activeWorkspaceId: 'workspace',
  workspaces: [{ id: 'workspace', root: temp }]
};
access.normalizeDeploymentConfig(config);
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

test('authenticates scoped team tokens and rewrites legacy owner authorization', async () => {
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
