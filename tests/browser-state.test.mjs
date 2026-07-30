import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/plugins/browser-runner.mjs';

test('reads nested QA state and evaluates bounded operators', () => {
  const state = { player: { health: 82, inventory: ['key', 'potion'] }, boss: { phase: 2 } };
  assert.equal(__test.stateValueAtPath(state, 'player.health'), 82);
  assert.equal(__test.compareQaValue(82, 'gte', 80), true);
  assert.equal(__test.compareQaValue(state.player.inventory, 'includes', 'key'), true);
  assert.equal(__test.compareQaValue(2, 'eq', 2), true);
});

test('blocks prototype traversal in QA state paths', () => {
  assert.throws(() => __test.stateValueAtPath({}, '__proto__.polluted'), /Unsafe QA state path/);
});
