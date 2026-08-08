'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  configurationKey,
  stableConfiguration
} = require('../vscode-host/shared-tunnel-record-store.js');

function base(overrides = {}) {
  return {
    provider: 'ngrok',
    ngrokUrl: 'https://devmate.ngrok-free.app',
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    deploymentMode: 'personal',
    ...overrides
  };
}

test('shared tunnel identity ignores host-local executable and credential-storage choices', () => {
  const vscode = base({
    ngrokCommandPath: 'C:\\Tools\\ngrok.exe',
    ngrokUseManagedAccount: true,
    cloudflareCommandPath: 'C:\\Tools\\cloudflared.exe'
  });
  const obsidian = base({
    ngrokCommandPath: 'ngrok',
    ngrokUseManagedAccount: false,
    cloudflareCommandPath: ''
  });

  assert.deepEqual(stableConfiguration(vscode, 8787), stableConfiguration(obsidian, 8787));
  assert.equal(configurationKey(vscode, 8787), configurationKey(obsidian, 8787));
});

test('shared tunnel identity still separates endpoint-affecting configuration', () => {
  assert.notEqual(
    configurationKey(base({ ngrokUrl: 'https://one.ngrok-free.app' }), 8787),
    configurationKey(base({ ngrokUrl: 'https://two.ngrok-free.app' }), 8787)
  );
  assert.notEqual(
    configurationKey(base({ ngrokPoolingEnabled: false }), 8787),
    configurationKey(base({ ngrokPoolingEnabled: true }), 8787)
  );
  assert.notEqual(configurationKey(base(), 8787), configurationKey(base(), 8788));
});
