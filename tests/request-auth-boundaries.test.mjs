import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateGatewayRequest, __test } from '../gateway/request-guard.mjs';

function loopbackOnlyConfig() {
  return {
    auth: { mode: 'none' },
    connection: { provider: 'ngrok', publicUrl: '' },
    team: { members: [] },
    requestPolicy: {},
    runtime: {},
    jobs: {}
  };
}

test('auth none means loopback-only owner access, never unauthenticated public ingress', () => {
  const publicHost = authenticateGatewayRequest(
    { headers: { host: 'devmate.example.com' }, socket: { remoteAddress: '127.0.0.1' } },
    new URL('http://localhost/mcp'),
    loopbackOnlyConfig()
  );
  assert.equal(publicHost, null);

  const spoofedLocalHost = authenticateGatewayRequest(
    { headers: { host: 'localhost:8787' }, socket: { remoteAddress: '203.0.113.10' } },
    new URL('http://localhost/mcp'),
    loopbackOnlyConfig()
  );
  assert.equal(spoofedLocalHost, null);

  const localPrincipal = authenticateGatewayRequest(
    { headers: { host: '127.0.0.1:8787' }, socket: { remoteAddress: '127.0.0.1' } },
    new URL('http://localhost/mcp'),
    loopbackOnlyConfig()
  );
  assert.equal(localPrincipal?.role, 'owner');
  assert.equal(localPrincipal?.source, 'local');

  const mappedIpv4Principal = authenticateGatewayRequest(
    { headers: { host: 'localhost:8787' }, socket: { remoteAddress: '::ffff:127.0.0.1' } },
    new URL('http://localhost/mcp'),
    loopbackOnlyConfig()
  );
  assert.equal(mappedIpv4Principal?.role, 'owner');
  assert.equal(mappedIpv4Principal?.source, 'local');
});

test('the ingress guard consumes authorization and strips credentials before the inner MCP handler', () => {
  for (const value of ['Bearer irrelevant-caller-value', 'Bearer oauth-access-token']) {
    const req = { headers: { authorization: value } };
    assert.equal(__test.normalizeInnerAuthorization(req), true);
    assert.equal(req.headers.authorization, undefined);
  }
});
