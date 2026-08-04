'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeSelector,
  propertyType,
  recordMatchesSelector,
  schemaFromRecords,
  sortRecords
} = require('../obsidian-plugin/src/bridge/vault-index-core.js');

function record(overrides = {}) {
  return {
    path: 'Projects/Alpha.md',
    name: 'Alpha',
    folder: 'Projects',
    createdAtMs: Date.parse('2026-01-01T00:00:00Z'),
    modifiedAtMs: Date.parse('2026-02-01T00:00:00Z'),
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-02-01T00:00:00.000Z',
    size: 100,
    tags: ['#project', '#active'],
    properties: { status: 'active', priority: 1, owners: ['Ada'] },
    headings: [],
    inboundLinks: 0,
    resolvedLinks: 0,
    unresolvedLinks: 0,
    embeds: 0,
    ...overrides
  };
}

test('normalizes and applies combined vault selectors', () => {
  const selector = normalizeSelector({
    folder: 'Projects',
    paths: ['Projects/Alpha'],
    tagsAll: ['project'],
    tagsAny: ['#active', '#review'],
    propertyExists: ['status'],
    propertyMissing: ['archivedAt'],
    properties: { status: 'active' },
    search: 'ada',
    modifiedAfter: '2026-01-15T00:00:00Z'
  });
  assert.equal(recordMatchesSelector(record(), selector), true);
  assert.equal(recordMatchesSelector(record({ tags: ['#project'] }), selector), false);
  assert.equal(recordMatchesSelector(record({ properties: { status: 'done', owners: ['Ada'] } }), selector), false);
  assert.equal(recordMatchesSelector(record({ modifiedAtMs: Date.parse('2026-01-01T00:00:00Z') }), selector), false);
});

test('builds coverage and inconsistent Property type diagnostics', () => {
  const records = [
    record(),
    record({ path: 'Projects/Beta.md', name: 'Beta', properties: { status: true, priority: 2 } }),
    record({ path: 'Projects/Gamma.md', name: 'Gamma', properties: { priority: 3 } })
  ];
  const schema = schemaFromRecords(records, { examplesPerProperty: 2 });
  const status = schema.properties.find(item => item.name === 'status');
  assert.deepEqual(status.types, { string: 1, boolean: 1 });
  assert.equal(status.present, 2);
  assert.equal(status.missing, 1);
  assert.equal(status.coverage, 0.6667);
  assert.deepEqual(schema.inconsistentTypes.map(item => item.name), ['status']);
  assert.equal(propertyType('2026-08-04'), 'date-string');
  assert.equal(propertyType(['one']), 'list');
});

test('sorts indexed notes deterministically', () => {
  const records = [
    record({ path: 'B.md', name: 'B', modifiedAtMs: 20 }),
    record({ path: 'A.md', name: 'A', modifiedAtMs: 20 }),
    record({ path: 'C.md', name: 'C', modifiedAtMs: 10 })
  ];
  assert.deepEqual(sortRecords(records, 'modified', 'desc').map(item => item.path), ['A.md', 'B.md', 'C.md']);
});
