'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'obsidian-plugin', 'src', 'main.js'), 'utf8');

test('Obsidian configured provider credentials fail closed when secure storage cannot decrypt them', () => {
  const start = source.indexOf('tunnelSecrets()');
  const end = source.indexOf('localTunnelSettings()', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /DEVMATE_OBSIDIAN_CREDENTIAL_DECRYPT_FAILED/);
  assert.match(block, /credential is configured but could not be decrypted/);
  assert.match(block, /throw wrapped/);
  assert.doesNotMatch(block, /Could not decrypt provider credential/);
  assert.doesNotMatch(block, /catch \(error\)[\s\S]*?return '';/);
});
