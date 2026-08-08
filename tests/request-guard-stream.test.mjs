import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/request-guard.mjs';

function request(host, remoteAddress = '203.0.113.10') {
  return { headers: { host }, socket: { remoteAddress } };
}

test('explicit Host policy accepts configured public hosts and rejects unrelated hosts', () => {
  const config = { requestPolicy: { allowedHosts: ['devmate.example.com'] } };
  assert.equal(__test.hostAllowed(request('devmate.example.com'), config), true);
  assert.equal(__test.hostAllowed(request('unrelated.example.com'), config), false);
  assert.equal(__test.hostAllowed(request('127.0.0.1:8787', '127.0.0.1'), config), true);
  assert.equal(__test.hostAllowed(request('localhost:8787'), config), false);
});

test('bounds global and principal concurrency independently', () => {
  const config = { requestPolicy: { maxConcurrentRequests: 2, maxConcurrentPerPrincipal: 1 } };
  const first = __test.enterConcurrency('alice', config);
  assert.equal(first.allowed, true);
  assert.equal(__test.enterConcurrency('alice', config).allowed, false);
  const second = __test.enterConcurrency('bob', config);
  assert.equal(second.allowed, true);
  assert.equal(__test.enterConcurrency('carol', config).allowed, false);
  first.release();
  second.release();
});
