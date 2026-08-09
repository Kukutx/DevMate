'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { effectiveTunnelSettings } = require('../vscode-host/effective-tunnel-settings.js');

function local(overrides = {}) {
  return {
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

test('shared instance connection is authoritative while execution details remain machine-local', () => {
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
});

test('shared ngrok URL is authoritative while account execution details remain machine-local', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: {
      connection: { provider: 'ngrok', publicUrl: 'https://shared.ngrok-free.app' }
    },
    localSettings: local()
  });
  assert.equal(result.provider, 'ngrok');
  assert.equal(result.ngrokUrl, 'https://shared.ngrok-free.app');
  assert.equal(result.publicUrl, '');
  assert.equal(result.ngrokUseManagedAccount, false);
  assert.equal(result.ngrokPoolingEnabled, true);
});

test('Cloudflare Quick never receives a stable URL', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: { connection: { provider: 'cloudflare-quick', publicUrl: '' } },
    localSettings: local()
  });
  assert.equal(result.provider, 'cloudflare-quick');
  assert.equal(result.publicUrl, '');
  assert.equal(result.ngrokUrl, '');
});

test('missing shared connection state fails closed instead of falling back to machine settings', () => {
  assert.throws(
    () => effectiveTunnelSettings({ sharedConfig: null, localSettings: local() }),
    error => error?.code === 'DEVMATE_SHARED_CONFIG_MISSING'
  );
});

test('invalid shared connection never silently falls back to machine settings', () => {
  assert.throws(() => effectiveTunnelSettings({
    sharedConfig: { connection: { provider: 'automatic', publicUrl: 'https://prod.example.com' } },
    localSettings: local()
  }), /Unknown connection provider/);
});
