import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSensitiveString } from '../gateway/local-shared.mjs';

test('redacts sensitive CLI flags with space, equals, quoted, and hyphenated names', () => {
  const cases = [
    ['node script.mjs --token top-secret', 'top-secret'],
    ['tool --token=top-secret', 'top-secret'],
    ['tool --client-secret="quoted secret value" --mode safe', 'quoted secret value'],
    ["tool --refresh_token 'refresh secret value'", 'refresh secret value'],
    ['tool --api-key sk-super-secret-value', 'sk-super-secret-value'],
    ['tool --owner-token owner-secret-value', 'owner-secret-value']
  ];
  for (const [input, secret] of cases) {
    const redacted = redactSensitiveString(input);
    assert.doesNotMatch(redacted, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(redacted, /=redacted/);
  }
});

test('does not redact ordinary CLI option values', () => {
  const input = 'node script.mjs --mode production --output artifacts/report.txt';
  assert.equal(redactSensitiveString(input), input);
});
