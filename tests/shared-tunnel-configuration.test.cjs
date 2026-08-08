'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { configurationKey, stableConfiguration } = require('../vscode-host/shared-tunnel-record-store.js');

function base(overrides = {}) {
  return {
    provider: 'ngrok',
    publicUrl: '',
    ngrokUrl: 'https://devmate.ngrok-free.app',
    ngrokCommandPath: 'ngrok',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: 'cloudflared',
    ...overrides
  };
}

test('shared tunnel identity includes provider runtime and account choices', () => {
  assert.notEqual(configurationKey(base({ ngrokCommandPath: 'C:\\Tools\\ngrok.exe' }), 8787), configurationKey(base({ ngrokCommandPath: 'ngrok' }), 8787));
  assert.notEqual(configurationKey(base({ ngrokUseManagedAccount: true }), 8787), configurationKey(base({ ngrokUseManagedAccount: false }), 8787));
  assert.notEqual(configurationKey(base({ provider: 'cloudflare-quick', cloudflareCommandPath: 'C:\\Tools\\cloudflared.exe' }), 8787), configurationKey(base({ provider: 'cloudflare-quick', cloudflareCommandPath: 'cloudflared' }), 8787));
});

test('shared tunnel identity separates endpoint-affecting configuration and port', () => {
  assert.notEqual(configurationKey(base({ ngrokUrl: 'https://one.ngrok-free.app' }), 8787), configurationKey(base({ ngrokUrl: 'https://two.ngrok-free.app' }), 8787));
  assert.notEqual(configurationKey(base({ ngrokPoolingEnabled: false }), 8787), configurationKey(base({ ngrokPoolingEnabled: true }), 8787));
  assert.notEqual(configurationKey(base(), 8787), configurationKey(base(), 8788));
});

test('stable tunnel configuration retains all current ownership-defining fields', () => {
  assert.deepEqual(stableConfiguration(base(), 8787), {
    port: 8787,
    provider: 'ngrok',
    publicUrl: '',
    ngrokUrl: 'https://devmate.ngrok-free.app',
    ngrokCommandPath: 'ngrok',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: 'cloudflared'
  });
});
