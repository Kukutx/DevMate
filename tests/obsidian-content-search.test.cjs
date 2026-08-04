'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSnippet,
  metadataScore,
  searchDocument,
  tokenizeQuery
} = require('../obsidian-plugin/src/bridge/content-search-core.js');

test('tokenizes quoted terms deterministically and removes duplicates', () => {
  assert.deepEqual(tokenizeQuery('forest "carbon stock" forest'), ['forest', 'carbon stock']);
  assert.deepEqual(tokenizeQuery('Exact Phrase', 'phrase'), ['Exact Phrase']);
  assert.deepEqual(tokenizeQuery('"Exact Phrase"', 'phrase'), ['Exact Phrase']);
});

test('rejects unique term sets beyond the explicit search bound', () => {
  const query = Array.from({ length: 21 }, (_, index) => `term${index}`).join(' ');
  assert.throws(() => tokenizeQuery(query), /exceeds 20 unique terms/);
});

test('supports phrase, all, any, and case-sensitive search modes', () => {
  const content = 'Forest carbon\nCarbon stocks are changing.\nFOREST monitoring.';
  assert.equal(searchDocument(content, { query: 'forest carbon', mode: 'phrase' }).matched, true);
  assert.equal(searchDocument(content, { query: '"forest carbon"', mode: 'phrase' }).matched, true);
  assert.equal(searchDocument(content, { query: 'forest changing', mode: 'all' }).matched, true);
  assert.equal(searchDocument(content, { query: 'missing changing', mode: 'any' }).matched, true);
  assert.equal(searchDocument(content, { query: 'forest', caseSensitive: true }).matched, false);
  assert.equal(searchDocument(content, { query: 'Forest', caseSensitive: true }).totalOccurrences, 1);
});

test('returns bounded snippets, line numbers, and stable scores', () => {
  const content = `${'x'.repeat(150)}\nTarget phrase appears here\n${'y'.repeat(150)}`;
  const result = searchDocument(content, { query: 'target phrase', mode: 'phrase', snippetChars: 100 });
  assert.equal(result.matched, true);
  assert.equal(result.line, 2);
  assert.ok(result.snippet.length <= 106);
  assert.match(result.snippet, /Target phrase/i);
  assert.ok(result.score >= 300);
  assert.match(buildSnippet(content, 151, 6, 80), /Target/i);
});

test('boosts title, path, heading, and tag matches', () => {
  const record = {
    name: 'Forest Carbon',
    path: 'Research/Forest Carbon.md',
    headings: [{ heading: 'Monitoring design' }],
    tags: ['#carbon']
  };
  assert.ok(metadataScore(record, ['forest', 'monitoring', '#carbon']) >= 150);
});
