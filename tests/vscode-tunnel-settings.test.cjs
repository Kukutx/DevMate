'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const settings = require('../vscode-host/tunnel-settings.js');

const root = path.resolve(__dirname, '..');

test('rejects unknown connection providers', () => {
  assert.equal(settings.tunnelProvider('ngrok'), 'ngrok');
  assert.equal(settings.tunnelProvider('cloudflare-managed'), 'cloudflare-managed');
  assert.throws(() => settings.tunnelProvider('automatic'), /Unknown connection provider/);
});

test('rejects coerced tunnel restart limits', () => {
  assert.equal(settings.tunnelMaxRestarts(undefined), 10);
  assert.equal(settings.tunnelMaxRestarts(0), 0);
  assert.equal(settings.tunnelMaxRestarts(100), 100);
  for (const value of ['10', null, -1, 101, 1.5, Number.NaN]) {
    assert.throws(() => settings.tunnelMaxRestarts(value), /must be an integer/);
  }
});

test('shared instance and effective runtime use one strict connection-provider contract', () => {
  const effective = fs.readFileSync(path.join(root, 'vscode-host/effective-tunnel-settings.js'), 'utf8');
  const schema = require('../shared/instance-config.cjs');
  assert.match(effective, /validateTunnelProvider/);
  assert.match(effective, /normalizeInstanceConfig/);
  assert.deepEqual(schema.CONNECTION_PROVIDERS, ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
});
