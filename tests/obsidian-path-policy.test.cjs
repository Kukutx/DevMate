'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  cleanFolderPath,
  cleanOperationId,
  cleanVaultPath,
  normalizeTag,
  propertyKey,
  withinFolder
} = require('../obsidian-plugin/src/bridge/path-policy.js');

test('normalizes safe vault paths and blocks internal or escaping paths', () => {
  assert.equal(cleanVaultPath('Projects\\Alpha', { markdown: true }), 'Projects/Alpha.md');
  assert.equal(cleanFolderPath(''), '');
  assert.equal(withinFolder('Projects/Alpha.md', 'Projects'), true);
  assert.throws(() => cleanVaultPath('../outside.md'), /inside the vault/);
  assert.throws(() => cleanVaultPath('.obsidian/workspace.json'), /internal configuration/);
  assert.throws(() => cleanVaultPath('A\0B.md'), /null byte/);
});

test('validates tags, Properties, and record IDs', () => {
  assert.equal(normalizeTag('project'), '#project');
  assert.equal(propertyKey('status'), 'status');
  assert.throws(() => propertyKey('__proto__'), /Invalid Obsidian property/);
  assert.equal(cleanOperationId('obs_abcdefgh', 'obs'), 'obs_abcdefgh');
  assert.throws(() => cleanOperationId('../bad', 'obs'), /Invalid obs record ID/);
});
