import assert from 'node:assert/strict';
import test from 'node:test';
import { handleOAuthRequest, __test } from '../gateway/oauth.mjs';

function responseRecorder() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(value = '') {
      this.body += String(value || '');
    }
  };
}

function request(host, remoteAddress = '203.0.113.10') {
  return {
    method: 'GET',
    headers: { host },
    socket: { remoteAddress }
  };
}

function config(allowedHosts) {
  return {
    auth: { mode: 'oauth' },
    requestPolicy: { allowedHosts }
  };
}

test('OAuth route catalog excludes retired dynamic registration', () => {
  assert.equal(__test.oauthRequestPath(new URL('https://devmate.example.com/.well-known/oauth-protected-resource/mcp')), true);
  assert.equal(__test.oauthRequestPath(new URL('https://devmate.example.com/oauth/authorize')), true);
  assert.equal(__test.oauthRequestPath(new URL('https://devmate.example.com/oauth/register')), false);
});

test('OAuth metadata rejects a Host outside the configured allowlist before deriving issuer or audience', async () => {
  const req = request('evil.example.com');
  const res = responseRecorder();
  const url = new URL('https://evil.example.com/.well-known/oauth-protected-resource/mcp');

  const handled = await handleOAuthRequest(req, res, url, config(['devmate.example.com']));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 421);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'invalid_request',
    error_description: 'OAuth request host is not allowed'
  });
});

test('OAuth metadata uses the allowed public Host after Host policy succeeds', async () => {
  const req = request('devmate.example.com');
  const res = responseRecorder();
  const url = new URL('https://devmate.example.com/.well-known/oauth-protected-resource/mcp');

  const handled = await handleOAuthRequest(req, res, url, config(['devmate.example.com']));

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  const metadata = JSON.parse(res.body);
  assert.equal(metadata.resource, 'https://devmate.example.com/mcp');
  assert.deepEqual(metadata.authorization_servers, ['https://devmate.example.com']);
});

test('loopback OAuth metadata requires both a loopback Host and loopback socket peer', async () => {
  const remoteReq = request('127.0.0.1:8787', '203.0.113.10');
  const remoteRes = responseRecorder();
  assert.equal(
    await handleOAuthRequest(
      remoteReq,
      remoteRes,
      new URL('http://127.0.0.1:8787/.well-known/oauth-authorization-server'),
      config([])
    ),
    true
  );
  assert.equal(remoteRes.statusCode, 421);

  const localReq = request('127.0.0.1:8787', '127.0.0.1');
  const localRes = responseRecorder();
  assert.equal(
    await handleOAuthRequest(
      localReq,
      localRes,
      new URL('http://127.0.0.1:8787/.well-known/oauth-authorization-server'),
      config([])
    ),
    true
  );
  assert.equal(localRes.statusCode, 200);
  assert.equal(JSON.parse(localRes.body).issuer, 'http://127.0.0.1:8787');
});
