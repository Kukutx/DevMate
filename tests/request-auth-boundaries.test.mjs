import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateGatewayRequest, __test } from '../gateway/request-guard.mjs';

function unauthenticatedConfig() {
  return {
    auth: { mode: 'none' },
    connection: { provider: 'ngrok', publicUrl: '' },
    team: { members: [] },
    requestPolicy: {},
    runtime: {},
    jobs: {}
  };
}

test('disabling authentication permits owner access through local and public ingress', () => {
  const publicHost = authenticateGatewayRequest(
    { headers: { host: 'devmate.example.com' }, socket: { remoteAddress: '127.0.0.1' } },
    new URL('http://localhost/mcp'),
    unauthenticatedConfig()
  );
  assert.equal(publicHost?.role, 'owner');
  assert.equal(publicHost?.source, 'local');

  const spoofedLocalHost = authenticateGatewayRequest(
    { headers: { host: 'localhost:8787' }, socket: { remoteAddress: '203.0.113.10' } },
    new URL('http://localhost/mcp'),
    unauthenticatedConfig()
  );
  assert.equal(spoofedLocalHost?.role, 'owner');
  assert.equal(spoofedLocalHost?.source, 'local');

  const localPrincipal = authenticateGatewayRequest(
    { headers: { host: '127.0.0.1:8787' }, socket: { remoteAddress: '127.0.0.1' } },
    new URL('http://localhost/mcp'),
    unauthenticatedConfig()
  );
  assert.equal(localPrincipal?.role, 'owner');
  assert.equal(localPrincipal?.source, 'local');

  const mappedIpv4Principal = authenticateGatewayRequest(
    { headers: { host: 'localhost:8787' }, socket: { remoteAddress: '::ffff:127.0.0.1' } },
    new URL('http://localhost/mcp'),
    unauthenticatedConfig()
  );
  assert.equal(mappedIpv4Principal?.role, 'owner');
});

test('no-auth strips irrelevant authorization while OAuth preserves its access token', () => {
  const req = {
    headers: {
      authorization: 'Bearer irrelevant-caller-value'
    }
  };
  assert.equal(__test.normalizeInnerAuthorization(req, {
    auth: { mode: 'none' }
  }), true);
  assert.equal(req.headers.authorization, undefined);

  const oauthReq = {
    headers: {
      authorization: 'Bearer oauth-access-token'
    }
  };
  assert.equal(__test.normalizeInnerAuthorization(oauthReq, {
    auth: { mode: 'oauth', oauth: { signingKey: 'a'.repeat(32), approvalCode: 'b'.repeat(16) } }
  }), true);
  assert.equal(oauthReq.headers.authorization, 'Bearer oauth-access-token');
});
