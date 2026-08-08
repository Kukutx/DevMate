'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  normalizeInstanceConfig,
  upgradeLegacyInstanceShape
} = require('../shared/instance-config.cjs');
const {
  ensurePersonalConfig,
  newPersonalConfig
} = require('../shared/config-store.cjs');

test('runtime normalization rejects retired deployment-mode fields', () => {
  assert.throws(() => normalizeInstanceConfig({
    deployment: { mode: 'personal', tunnelProvider: 'ngrok', publicUrl: '' },
    team: { enabled: false },
    production: {}
  }), error => error?.code === 'retired_instance_shape');
});

test('explicit one-time shape upgrade preserves capability values and deletes retired fields', () => {
  const config = {
    connection: { lastError: 'preserve-me' },
    deployment: { mode: 'production', tunnelProvider: 'external', publicUrl: 'https://devmate.example.com' },
    team: { enabled: true, members: [] },
    production: { requestsPerMinute: 321, allowedHosts: ['devmate.example.com'] }
  };
  upgradeLegacyInstanceShape(config);
  assert.equal(config.connection.provider, 'external');
  assert.equal(config.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(config.connection.lastError, 'preserve-me');
  assert.equal(config.requestPolicy.requestsPerMinute, 321);
  assert.deepEqual(config.requestPolicy.allowedHosts, ['devmate.example.com']);
  assert.equal('enabled' in config.team, false);
  assert.equal('deployment' in config, false);
  assert.equal('production' in config, false);
  assert.doesNotThrow(() => normalizeInstanceConfig(config));
});

test('host initialization performs the same-version legacy shape upgrade once and persists only current capabilities', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shape-upgrade-'));
  const workspace = path.join(directory, 'workspace');
  const configFile = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  const legacy = newPersonalConfig({ workspaceRoot: workspace });
  legacy.deployment = { mode: 'team', tunnelProvider: 'ngrok', publicUrl: 'https://stable.ngrok.app' };
  legacy.production = { ...legacy.requestPolicy, requestsPerMinute: 222 };
  legacy.team.enabled = true;
  delete legacy.connection;
  delete legacy.requestPolicy;
  fs.writeFileSync(configFile, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
  try {
    const upgraded = ensurePersonalConfig({ configFile, workspaceRoot: workspace });
    assert.equal(upgraded.connection.provider, 'ngrok');
    assert.equal(upgraded.connection.publicUrl, 'https://stable.ngrok.app');
    assert.equal(upgraded.requestPolicy.requestsPerMinute, 222);
    assert.equal('deployment' in upgraded, false);
    assert.equal('production' in upgraded, false);
    assert.equal('enabled' in upgraded.team, false);
    const persisted = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    assert.equal('deployment' in persisted, false);
    assert.equal('production' in persisted, false);
    assert.equal('enabled' in persisted.team, false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
