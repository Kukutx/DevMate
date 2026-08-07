import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRequestConcurrencyLimiter,
  sharedHttpRequestConcurrency
} from '../gateway/request-concurrency.mjs';

test('enforces global and per-principal limits with idempotent release', () => {
  const limiter = createRequestConcurrencyLimiter();
  const a1 = limiter.enter('a', 3, 2);
  const a2 = limiter.enter('a', 3, 2);
  assert.equal(a1.allowed, true);
  assert.equal(a2.allowed, true);
  assert.deepEqual(limiter.enter('a', 3, 2), { allowed: false, reason: 'principal', current: 2, limit: 2 });
  const b1 = limiter.enter('b', 3, 2);
  assert.equal(b1.allowed, true);
  assert.deepEqual(limiter.enter('c', 3, 2), { allowed: false, reason: 'global', current: 3, limit: 3 });
  a1.release();
  a1.release();
  assert.equal(limiter.global(), 2);
  assert.equal(limiter.principals.get('a'), 1);
  b1.release();
  a2.release();
  assert.equal(limiter.global(), 0);
  assert.equal(limiter.principals.size, 0);
});

test('shared HTTP limiter provides one process-wide budget across endpoint namespaces', () => {
  sharedHttpRequestConcurrency.reset();
  const mcp = sharedHttpRequestConcurrency.enter('mcp:alice', 1, 1);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(
    sharedHttpRequestConcurrency.enter('runner:worker-1', 1, 1),
    { allowed: false, reason: 'global', current: 1, limit: 1 }
  );
  mcp.release();
  sharedHttpRequestConcurrency.reset();
});

test('rejects invalid concurrency values instead of coercing them', () => {
  const limiter = createRequestConcurrencyLimiter();
  assert.throws(() => limiter.enter('', 1, 1), /principalId/);
  assert.throws(() => limiter.enter('a', '1', 1), /maxGlobal/);
  assert.throws(() => limiter.enter('a', 1, 0), /maxPrincipal/);
});
