'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { BridgeMetrics } = require('../obsidian-plugin/src/bridge/bridge-metrics.js');

test('tracks local action counts and bounded timing summaries without request payloads', () => {
  let now = Date.parse('2026-08-04T00:00:00Z');
  const metrics = new BridgeMetrics(() => now);
  const first = metrics.begin('query_notes');
  now += 12;
  metrics.finish(first);
  const second = metrics.begin('query_notes');
  now += 8;
  metrics.finish(second, new Error('private path must not be retained'));
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.errors, 1);
  assert.equal(snapshot.active, 0);
  assert.deepEqual(snapshot.actions[0], {
    action: 'query_notes', requests: 2, errors: 1, averageDurationMs: 10, maxDurationMs: 12,
    lastAt: '2026-08-04T00:00:00.020Z'
  });
  assert.equal(JSON.stringify(snapshot).includes('private path'), false);
});
