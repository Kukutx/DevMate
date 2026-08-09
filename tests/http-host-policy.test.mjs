import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostAllowed,
  isLocalRequest,
  isLoopbackAddress,
  isLoopbackHostname,
  loopbackHost,
  loopbackSocket
} from '../gateway/http-host-policy.mjs';

function request(host, remoteAddress) {
  return { headers: { host }, socket: { remoteAddress } };
}

test('recognizes only actual loopback socket addresses', () => {
  for (const value of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(value), true, value);
  for (const value of ['', '0.0.0.0', '192.168.1.10', '203.0.113.10', '::ffff:203.0.113.10']) assert.equal(isLoopbackAddress(value), false, value);
});

test('normalizes URL loopback hostnames including IPv6 brackets and the full 127/8 range', () => {
  for (const value of ['localhost', '127.0.0.1', '127.9.8.7', '::1', '[::1]', '[::ffff:127.0.0.1]']) assert.equal(isLoopbackHostname(value), true, value);
  for (const value of ['example.com', '192.168.1.2', '[2001:db8::1]']) assert.equal(isLoopbackHostname(value), false, value);
});

test('local request requires both loopback Host and loopback socket', () => {
  assert.equal(loopbackHost(request('localhost:8787', '203.0.113.10')), true);
  assert.equal(loopbackSocket(request('localhost:8787', '203.0.113.10')), false);
  assert.equal(isLocalRequest(request('localhost:8787', '203.0.113.10')), false);
  assert.equal(isLocalRequest(request('127.0.0.1:8787', '127.0.0.1')), true);
});

test('explicit Host allowlist cannot be bypassed with a spoofed localhost Host header', () => {
  const restricted = { requestPolicy: { allowedHosts: ['devmate.example.com'] } };
  assert.equal(hostAllowed(request('devmate.example.com', '203.0.113.10'), restricted), true);
  assert.equal(hostAllowed(request('evil.example.com', '203.0.113.10'), restricted), false);
  assert.equal(hostAllowed(request('localhost:8787', '203.0.113.10'), restricted), false);
  assert.equal(hostAllowed(request('localhost:8787', '127.0.0.1'), restricted), true);
});

test('an empty Host allowlist permits public Hosts but never treats spoofed localhost as local', () => {
  const unrestricted = { requestPolicy: { allowedHosts: [] } };
  assert.equal(hostAllowed(request('devmate.example.com', '203.0.113.10'), unrestricted), true);
  assert.equal(hostAllowed(request('localhost:8787', '203.0.113.10'), unrestricted), false);
});
