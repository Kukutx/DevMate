import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const gateway = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
const synchronizer = fs.readFileSync(path.join(root, 'scripts', 'sync-version.mjs'), 'utf8');

test('production runtimes read their version from package metadata', () => {
  assert.match(extension, /version: VERSION.*require\('\.\/package\.json'\)/);
  assert.match(gateway, /packageJson from '\.\.\/package\.json'/);
  assert.match(gateway, /const VERSION = packageJson\.version/);
  assert.doesNotMatch(extension, /const VERSION = '\d+\.\d+\.\d+'/);
  assert.doesNotMatch(gateway, /const VERSION = '\d+\.\d+\.\d+'/);
});

test('version synchronization does not rewrite production source files', () => {
  assert.doesNotMatch(synchronizer, /updateText\('extension\.js'/);
  assert.doesNotMatch(synchronizer, /updateText\('gateway\/server\.mjs'/);
});
