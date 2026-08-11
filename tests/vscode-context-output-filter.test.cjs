'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('VS Code context capture excludes its own Output documents', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'extension.js'), 'utf8');
  const start = source.indexOf('function collectVsCodeContext()');
  const end = source.indexOf('function redactUrl', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /editor\.document\.uri\.scheme !== 'output'/);
  assert.match(block, /filter\(e=>e\.document\.uri\.scheme !== 'output'\)/);
});
