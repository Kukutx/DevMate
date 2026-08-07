import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostAllowed,
  isLocalRequest,
  isLoopbackAddress,
  loopbackHost,
  loopbackSocket
} from '../gateway/http-host-policy.mjs';

function request(host, remoteAddress) {
  return { headers: { host }, socket: { remoteAddress } };
}

test('recognizes only actual loopback socket addresses', () => {
  for (const value of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(value), true, value);
  }
  for (const value of ['', '0.0.0.0', '192.168.1.10', '203.0.113.10', '::ffff:203.0.113.10']) {
    assert.equal(isLoopbackAddress(value), false, value);
  }
});

test('local request requires both loopback Host and loopback socket', () => {
  assert.equal(loopbackHost(request('localhost:8787', '203.0.113.10')), true);
  assert.equal(loopbackSocket(request('localhost:8787', '203.0.113.10')), false);
  assert.equal(isLocalRequest(request('localhost:8787', '203.0.113.10')), false);
  assert.equal(isLocalRequest(request('127.0.0.1:8787', '127.0.0.1')), true);
});

test('production Host policy cannot be bypassed with a spoofed localhost Host header', () => {
  const production = { deployment: { mode: 'production' }, production: { allowedHosts: ['devmate.example.com'] } };
  assert.equal(hostAllowed(request('devmate.example.com', '203.0.113.10'), production), true);
  assert.equal(hostAllowed(request('evil.example.com', '203.0.113.10'), production), false);
  assert.equal(hostAllowed(request('localhost:8787', '203.0.113.10'), production), false);
  assert.equal(hostAllowed(request('localhost:8787', '127.0.0.1'), production), true);
});

test('team mode stays permissive for public Hosts but never treats spoofed localhost as local', () => {
  const team = { deployment: { mode: 'team' }, production: { allowedHosts: [] } };
  assert.equal(hostAllowed(request('devmate.example.com', '203.0.113.10'), team), true);
  assert.equal(hostAllowed(request('localhost:8787', '203.0.113.10'), team), false);
});
