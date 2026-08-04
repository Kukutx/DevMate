'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertPlanReady,
  propertyPreview,
  serializedSelector
} = require('../obsidian-plugin/src/bridge/property-batch-core.js');

test('previews only effective Property changes', () => {
  const unchanged = propertyPreview({ status: 'active' }, { set: { status: 'active' }, remove: [] });
  assert.equal(unchanged.changed, false);

  const changed = propertyPreview(
    { status: 'active', obsolete: true },
    { set: { status: 'done', priority: 1 }, remove: ['obsolete'] }
  );
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.before, { status: 'active', priority: undefined, obsolete: true });
  assert.deepEqual(changed.after, { status: 'done', priority: 1, obsolete: undefined });
});

test('serializes selectors without internal Set state', () => {
  const output = serializedSelector({
    folder: 'Projects', paths: ['Projects/A.md'], pathSet: new Set(['Projects/A.md']),
    tagsAll: ['#project'], tagsAny: [], propertyExists: [], propertyMissing: [],
    properties: { status: 'active' }, search: '',
    modifiedAfter: Date.parse('2026-01-01T00:00:00Z'), modifiedBefore: null
  });
  assert.equal(Object.hasOwn(output, 'pathSet'), false);
  assert.equal(output.modifiedAfter, '2026-01-01T00:00:00.000Z');
});

test('requires an unexpired ready or conflict plan', () => {
  const now = Date.parse('2026-08-04T00:00:00Z');
  assert.doesNotThrow(() => assertPlanReady({ kind: 'properties_batch', status: 'ready', expiresAt: '2026-08-05T00:00:00Z' }, now));
  assert.throws(() => assertPlanReady({ kind: 'properties_batch', status: 'applied', expiresAt: '2026-08-05T00:00:00Z' }, now), /cannot be applied/);
  assert.throws(() => assertPlanReady({ kind: 'properties_batch', status: 'ready', expiresAt: '2026-08-03T00:00:00Z' }, now), /expired/);
});
