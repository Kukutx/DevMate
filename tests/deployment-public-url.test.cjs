'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  allowedHosts,
  stablePublicUrl
} = require('../vscode-host/deployment-public-url.js');

test('ngrok stable deployment URL comes only from ngrokUrl', () => {
  assert.equal(stablePublicUrl({
    provider: 'ngrok',
    ngrokUrl: 'https://stable.ngrok-free.app',
    publicUrl: 'https://stale-external.example.com'
  }), 'https://stable.ngrok-free.app');
  assert.equal(stablePublicUrl({
    provider: 'ngrok',
    ngrokUrl: '',
    publicUrl: 'https://stale-external.example.com'
  }), '');
});

test('Cloudflare Quick never inherits a stale stable URL', () => {
  assert.equal(stablePublicUrl({
    provider: 'cloudflare-quick',
    publicUrl: 'https://stale-external.example.com',
    ngrokUrl: 'https://stale.ngrok-free.app'
  }), '');
});

test('Cloudflare managed and external use only their configured publicUrl', () => {
  assert.equal(stablePublicUrl({
    provider: 'cloudflare-managed',
    publicUrl: 'https://cloudflare.example.com',
    ngrokUrl: 'https://stale.ngrok-free.app'
  }), 'https://cloudflare.example.com');
  assert.equal(stablePublicUrl({
    provider: 'external',
    publicUrl: 'https://external.example.com',
    ngrokUrl: 'https://stale.ngrok-free.app'
  }), 'https://external.example.com');
});

test('automatic Host allowlist contribution follows only the selected provider stable URL', () => {
  assert.deepEqual(allowedHosts(['manual.example.com'], 'https://stable.example.com:8443'), [
    'manual.example.com',
    'stable.example.com:8443'
  ]);
  assert.deepEqual(allowedHosts(['manual.example.com'], ''), ['manual.example.com']);
});
