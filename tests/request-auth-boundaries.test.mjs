import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateGatewayRequest, __test } from '../gateway/request-guard.mjs';

function unauthenticatedPersonalConfig() {
  return {
    auth: { required: false },
    deployment: { mode: 'personal' },
    team: {},
    production: {},
    runtime: {},
    jobs: {}
  };
}

test('unauthenticated personal owner access is loopback-host only', () => {
  const publicPrincipal = authenticateGatewayRequest(
    { headers: { host: 'devmate.example.com' }, socket: { remoteAddress: '127.0.0.1' } },
    new URL('http://localhost/mcp'),
    unauthenticatedPersonalConfig()
  );
  assert.equal(publicPrincipal, null);

  const localPrincipal = authenticateGatewayRequest(
    { headers: { host: '127.0.0.1:8787' }, socket: { remoteAddress: '127.0.0.1' } },
    new URL('http://localhost/mcp'),
    unauthenticatedPersonalConfig()
  );
  assert.equal(localPrincipal?.role, 'owner');
  assert.equal(localPrincipal?.source, 'local');
});

test('inner Gateway never receives the caller credential', () => {
  const req = {
    headers: {
      authorization: 'Bearer dmt_member_secret',
      'x-devmate-token': 'dmt_member_secret'
    }
  };
  assert.equal(__test.normalizeInnerAuthorization(req, {
    auth: { required: true, token: 'owner-token' }
  }, { source: 'team-token' }), true);
  assert.equal(req.headers.authorization, 'Bearer owner-token');
  assert.equal(req.headers['x-devmate-token'], undefined);

  const openReq = {
    headers: {
      authorization: 'Bearer caller-secret',
      'x-devmate-token': 'caller-secret'
    }
  };
  assert.equal(__test.normalizeInnerAuthorization(openReq, {
    auth: { required: false }
  }, { source: 'local' }), true);
  assert.equal(openReq.headers.authorization, undefined);
  assert.equal(openReq.headers['x-devmate-token'], undefined);
});
