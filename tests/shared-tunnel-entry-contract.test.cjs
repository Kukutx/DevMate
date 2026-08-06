'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('VS Code uses the shared tunnel entry and preserves reverse teardown ordering', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');

  const source = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(source, /await baseEntry\.activate\(context\)/);
  assert.match(source, /new SharedTunnelRuntime\(/);
  assert.match(source, /\.install\(\)/);
  const suspend = source.indexOf('current?.suspendSpawn()');
  const deactivate = source.indexOf('await baseEntry.deactivate()');
  const dispose = source.indexOf("await current?.dispose({ stopOwned: true })");
  assert.ok(suspend >= 0 && deactivate > suspend, 'Shared spawn layer must be removed before inner layers');
  assert.ok(dispose > deactivate, 'Shared HTTP ownership protection must remain through inner shutdown');
});

test('VSIX smoke contract includes the shared tunnel entry and runtime', () => {
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-vsix-worker.mjs'), 'utf8');
  assert.match(smoke, /extension-entry-shared-tunnel\.js/);
  assert.match(smoke, /vscode-host\/shared-tunnel-runtime\.js/);
});
