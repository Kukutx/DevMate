'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { effectiveTunnelSettings } = require('../vscode-host/effective-tunnel-settings.js');

function local(overrides = {}) {
  return {
    provider: 'ngrok',
    publicUrl: 'https://machine-external.example.com',
    ngrokUrl: 'https://machine.ngrok-free.app',
    ngrokCommandPath: 'C:\\Tools\\ngrok.exe',
    ngrokUseManagedAccount: false,
    ngrokPoolingEnabled: true,
    ngrokTrafficPolicyFile: 'C:\\policy.yml',
    cloudflareCommandPath: 'C:\\Tools\\cloudflared.exe',
    autoRestart: true,
    maxRestarts: 7,
    ...overrides
  };
}

test('shared instance connection overrides stale machine connection candidates', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: {
      connection: { provider: 'cloudflare-managed', publicUrl: 'https://prod.example.com' }
    },
    localSettings: local()
  });
  assert.equal(result.provider, 'cloudflare-managed');
  assert.equal(result.publicUrl, 'https://prod.example.com');
  assert.equal(result.ngrokUrl, '');
  assert.equal(result.cloudflareCommandPath, 'C:\\Tools\\cloudflared.exe');
  assert.equal(result.ngrokCommandPath, 'C:\\Tools\\ngrok.exe');
  assert.equal(result.autoRestart, true);
  assert.equal(result.maxRestarts, 7);
  assert.equal('deploymentMode' in result, false);
});

test('shared ngrok URL is authoritative while account execution details remain machine-local', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: {
      connection: { provider: 'ngrok', publicUrl: 'https://shared.ngrok-free.app' }
    },
    localSettings: local({ ngrokUrl: 'https://stale-machine.ngrok-free.app' })
  });
  assert.equal(result.provider, 'ngrok');
  assert.equal(result.ngrokUrl, 'https://shared.ngrok-free.app');
  assert.equal(result.publicUrl, '');
  assert.equal(result.ngrokUseManagedAccount, false);
  assert.equal(result.ngrokPoolingEnabled, true);
});

test('Cloudflare Quick never inherits a stable URL from any machine setting', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: { connection: { provider: 'cloudflare-quick', publicUrl: '' } },
    localSettings: local()
  });
  assert.equal(result.provider, 'cloudflare-quick');
  assert.equal(result.publicUrl, '');
  assert.equal(result.ngrokUrl, '');
});

test('machine connection candidates are used only before shared instance config exists', () => {
  const result = effectiveTunnelSettings({ sharedConfig: null, localSettings: local() });
  assert.equal(result.provider, 'ngrok');
  assert.equal(result.ngrokUrl, 'https://machine.ngrok-free.app');
  assert.equal('deploymentMode' in result, false);
});

test('invalid shared connection never silently falls back to machine settings', () => {
  assert.throws(() => effectiveTunnelSettings({
    sharedConfig: { connection: { provider: 'automatic', publicUrl: 'https://prod.example.com' } },
    localSettings: local()
  }), /Unknown connection provider/);
});
