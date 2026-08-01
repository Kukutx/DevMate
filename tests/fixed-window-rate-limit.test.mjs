import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeFixedWindow, pruneFixedWindowStore } from '../gateway/fixed-window-rate-limit.mjs';

test('enforces a fixed-window request limit', () => {
  const store = new Map();
  assert.deepEqual(consumeFixedWindow(store, 'alice', 2, { now: 1000, windowMs: 1000 }), {
    allowed: true,
    remaining: 1,
    resetAt: 2000
  });
  assert.equal(consumeFixedWindow(store, 'alice', 2, { now: 1500, windowMs: 1000 }).allowed, true);
  assert.equal(consumeFixedWindow(store, 'alice', 2, { now: 1600, windowMs: 1000 }).allowed, false);
  assert.equal(consumeFixedWindow(store, 'alice', 2, { now: 2000, windowMs: 1000 }).allowed, true);
});

test('evicts old identities and never exceeds the configured cap', () => {
  const store = new Map();
  for (let index = 0; index < 200; index += 1) {
    consumeFixedWindow(store, `ip:${index}`, 10, {
      now: index * 1000,
      windowMs: 1000,
      maxEntries: 25
    });
    assert.ok(store.size <= 25);
  }
});

test('prunes expired windows before removing active entries', () => {
  const store = new Map([
    ['old', { window: 1, count: 1, lastSeenAt: 1000 }],
    ['recent', { window: 9, count: 1, lastSeenAt: 9000 }],
    ['current', { window: 10, count: 1, lastSeenAt: 10000 }]
  ]);
  pruneFixedWindowStore(store, { currentWindow: 10, maxEntries: 10 });
  assert.equal(store.has('old'), false);
  assert.equal(store.has('recent'), true);
  assert.equal(store.has('current'), true);
});
