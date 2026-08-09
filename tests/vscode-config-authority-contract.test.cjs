'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');

test('VS Code base extension has exactly one shared config authority', () => {
  assert.match(source, /function readConfig\(p\)\{ return readExtensionConfig\(p\); \}/);
  assert.doesNotMatch(source, /function defaultConfig\s*\(/);
  assert.doesNotMatch(source, /Math\.max\(SUPPORTED_CONFIG_VERSION/);
  assert.doesNotMatch(source, /readConfig\(p\) \|\|/);

  const ensureStart = source.indexOf('function ensureConfig(ctx');
  const ensureEnd = source.indexOf('function scheduleContextRefresh', ensureStart);
  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
  const ensure = source.slice(ensureStart, ensureEnd);
  assert.match(ensure, /const data = readConfig\(p\)/);
  assert.match(ensure, /DEVMATE_SHARED_CONFIG_MISSING/);
  assert.doesNotMatch(ensure, /newAuthToken\(\).*instanceId|defaultConfig/);
});

test('workspace package metadata uses a generic JSON reader instead of the DevMate config parser', () => {
  assert.match(source, /function readJsonFile\(p\)/);
  const start = source.indexOf('function packageScripts(root)');
  const end = source.indexOf('function safeRootFiles', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /readJsonFile\(path\.join\(root,'package\.json'\)\)/);
  assert.doesNotMatch(block, /readExtensionConfig|readConfig/);
});
