import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/request-guard.mjs';

test('accepts configured production hosts and rejects unrelated hosts', () => {
  const config = { production: { allowedHosts: ['devmate.example.com'] } };
  assert.equal(__test.hostAllowed({ headers: { host: 'devmate.example.com' } }, config), true);
  assert.equal(__test.hostAllowed({ headers: { host: 'unrelated.example.com' } }, config), false);
  assert.equal(__test.hostAllowed({ headers: { host: '127.0.0.1:8787' } }, config), true);
});

test('bounds global and principal concurrency independently', () => {
  const config = { production: { maxConcurrentRequests: 2, maxConcurrentPerPrincipal: 1 } };
  const first = __test.enterConcurrency('alice', config);
  assert.equal(first.allowed, true);
  assert.equal(__test.enterConcurrency('alice', config).allowed, false);
  const second = __test.enterConcurrency('bob', config);
  assert.equal(second.allowed, true);
  assert.equal(__test.enterConcurrency('carol', config).allowed, false);
  first.release();
  second.release();
});
