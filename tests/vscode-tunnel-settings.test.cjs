'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const settings = require('../vscode-host/tunnel-settings.js');

const root = path.resolve(__dirname, '..');

test('rejects unknown tunnel providers and deployment modes', () => {
  assert.equal(settings.tunnelProvider('ngrok'), 'ngrok');
  assert.equal(settings.deploymentMode('production'), 'production');
  assert.throws(() => settings.tunnelProvider('automatic'), /Unknown tunnel provider/);
  assert.throws(() => settings.deploymentMode('prod'), /Unknown deployment mode/);
});

test('rejects coerced tunnel restart limits', () => {
  assert.equal(settings.tunnelMaxRestarts(undefined), 10);
  assert.equal(settings.tunnelMaxRestarts(0), 0);
  assert.equal(settings.tunnelMaxRestarts(100), 100);
  for (const value of ['10', null, -1, 101, 1.5, Number.NaN]) {
    assert.throws(() => settings.tunnelMaxRestarts(value), /must be an integer/);
  }
});

test('platform entry uses strict validators instead of provider or numeric fallbacks', () => {
  const source = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
  assert.match(source, /validateTunnelProvider/);
  assert.match(source, /validateDeploymentMode/);
  assert.match(source, /strictInteger/);
  assert.doesNotMatch(source, /normalizeProvider/);
  assert.doesNotMatch(source, /Number\(setting\('production/);
});
