
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, '..', 'scripts', 'devmate-runner.mjs'),
  'utf8'
);

test('external Runner reads config through the shared strict store', () => {
  assert.match(source, /shared\/config-store\.cjs/);
  assert.match(source, /readConfigJson\(file, null, \{ strict: true, supportedVersion: true \}\)/);
  assert.doesNotMatch(source, /JSON\.parse\(fs\.readFileSync\(file/);
});

test('external Runner keeps its local Gateway private and owns its process tree', () => {
  assert.match(source, /DEVMATE_BIND_HOST: '127\.0\.0\.1'/);
  assert.match(source, /detached: process\.platform !== 'win32'/);
  assert.match(source, /await terminateProcessTree\(child\)/);
  assert.doesNotMatch(source, /child\.kill\(\)/);
});
