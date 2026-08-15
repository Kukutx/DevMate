import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveString } from '../gateway/local-shared.mjs';

function escaped(value) {
  return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

test('redacts sensitive CLI flags with space, equals, quoted, and hyphenated names', () => {
  const cases = [
    ['node script.mjs --token top-secret', 'top-secret'],
    ['tool --token=top-secret', 'top-secret'],
    ['tool --client-secret="quoted secret value" --mode safe', 'quoted secret value'],
    ["tool --refresh_token 'refresh secret value'", 'refresh secret value'],
    ['tool --api-key sk-super-secret-value', 'sk-super-secret-value'],
    ['tool --owner-token owner-secret-value', 'owner-secret-value'],
    ['tool --auth-token auth-secret-value', 'auth-secret-value']
  ];
  for (const [input, secret] of cases) {
    const redacted = redactSensitiveString(input);
    assert.doesNotMatch(redacted, escaped(secret));
    assert.match(redacted, /=redacted/);
  }
});

test('redacts bearer headers before generic authorization handling', () => {
  for (const input of [
    'Authorization: Bearer abc.def-123',
    'authorization=Bearer abcdef123',
    'prefix Bearer standalone-token suffix'
  ]) {
    const redacted = redactSensitiveString(input);
    assert.doesNotMatch(redacted, /abc\.def-123|abcdef123|standalone-token/);
    assert.match(redacted, /redacted/);
  }
});

test('redacts quoted key-value secrets without leaking trailing words', () => {
  const input = 'password="two word password" client_secret=client-value refresh-token="refresh value"';
  const redacted = redactSensitiveString(input);
  assert.doesNotMatch(redacted, /two word password|client-value|refresh value/);
  assert.equal((redacted.match(/redacted/g) || []).length, 3);
});

test('redacts sensitive URL query parameter variants exactly', () => {
  const input = 'https://example.test/callback?access_token=access-secret&client_secret=client-secret&mode=safe';
  assert.equal(
    redactSensitiveString(input),
    'https://example.test/callback?access_token=redacted&client_secret=redacted&mode=safe'
  );
});

test('does not redact ordinary CLI option values', () => {
  const input = 'node script.mjs --mode production --output artifacts/report.txt';
  assert.equal(redactSensitiveString(input), input);
});
