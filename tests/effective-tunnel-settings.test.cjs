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
    deploymentMode: 'personal',
    ...overrides
  };
}

test('shared deployment provider and mode override stale machine business settings', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: {
      deployment: {
        mode: 'production',
        tunnelProvider: 'cloudflare-managed',
        publicUrl: 'https://prod.example.com'
      }
    },
    localSettings: local()
  });
  assert.equal(result.provider, 'cloudflare-managed');
  assert.equal(result.deploymentMode, 'production');
  assert.equal(result.publicUrl, 'https://prod.example.com');
  assert.equal(result.ngrokUrl, '');
  assert.equal(result.cloudflareCommandPath, 'C:\\Tools\\cloudflared.exe');
  assert.equal(result.ngrokCommandPath, 'C:\\Tools\\ngrok.exe');
  assert.equal(result.autoRestart, true);
  assert.equal(result.maxRestarts, 7);
});

test('shared ngrok stable URL becomes the actual ngrok endpoint instead of a machine cache', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: {
      deployment: {
        mode: 'team',
        tunnelProvider: 'ngrok',
        publicUrl: 'https://shared.ngrok-free.app'
      }
    },
    localSettings: local({ ngrokUrl: 'https://stale-machine.ngrok-free.app' })
  });
  assert.equal(result.provider, 'ngrok');
  assert.equal(result.deploymentMode, 'team');
  assert.equal(result.ngrokUrl, 'https://shared.ngrok-free.app');
  assert.equal(result.publicUrl, '');
  assert.equal(result.ngrokUseManagedAccount, false, 'account storage remains a machine execution detail');
  assert.equal(result.ngrokPoolingEnabled, true, 'pooling remains a machine execution detail');
});

test('Cloudflare Quick never inherits a stable URL from any machine setting', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: {
      deployment: {
        mode: 'team',
        tunnelProvider: 'cloudflare-quick',
        publicUrl: ''
      }
    },
    localSettings: local()
  });
  assert.equal(result.provider, 'cloudflare-quick');
  assert.equal(result.publicUrl, '');
  assert.equal(result.ngrokUrl, '');
});

test('machine business settings are only a bootstrap fallback before shared config exists', () => {
  const result = effectiveTunnelSettings({
    sharedConfig: null,
    localSettings: local({ deploymentMode: 'personal', provider: 'ngrok' })
  });
  assert.equal(result.provider, 'ngrok');
  assert.equal(result.deploymentMode, 'personal');
  assert.equal(result.ngrokUrl, 'https://machine.ngrok-free.app');
});

test('invalid shared deployment never silently falls back to machine settings', () => {
  assert.throws(() => effectiveTunnelSettings({
    sharedConfig: {
      deployment: {
        mode: 'production',
        tunnelProvider: 'automatic',
        publicUrl: 'https://prod.example.com'
      }
    },
    localSettings: local()
  }), /Unknown tunnel provider/);
});
