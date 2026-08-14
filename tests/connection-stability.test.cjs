'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cleanHttpsOrigin, publicConnectionStability } = require('../shared/connection-stability.cjs');

test('only a clean HTTPS origin is accepted as a persistent public address', () => {
  assert.equal(cleanHttpsOrigin(' https://devmate.example.com '), 'https://devmate.example.com');
  for (const invalid of [
    'http://devmate.example.com',
    'https://devmate.example.com/mcp',
    'https://user:password@devmate.example.com',
    'https://devmate.example.com?token=nope',
    'not-a-url'
  ]) {
    assert.equal(cleanHttpsOrigin(invalid), '');
  }
});

test('quick tunnels remain session-only even after public MCP verification', () => {
  const result = publicConnectionStability({
    provider: 'cloudflare-quick',
    publicUrl: 'https://temporary.trycloudflare.com'
  });
  assert.equal(result.kind, 'temporary');
  assert.equal(result.chatgptEligible, false);
  assert.equal(result.publicUrl, '');
});

test('persistent ChatGPT eligibility requires an explicit stable origin', () => {
  assert.equal(publicConnectionStability({ provider: 'ngrok' }).kind, 'unconfigured');
  const result = publicConnectionStability({
    provider: 'ngrok',
    publicUrl: 'https://devmate.example.ngrok.app'
  });
  assert.equal(result.kind, 'stable');
  assert.equal(result.chatgptEligible, true);
  assert.equal(result.publicUrl, 'https://devmate.example.ngrok.app');
});

test('unknown connection providers fail closed', () => {
  assert.throws(() => publicConnectionStability({ provider: 'made-up' }), /Unknown connection provider/);
});
