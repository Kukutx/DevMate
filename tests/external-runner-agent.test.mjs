import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../scripts/devmate-runner.mjs';

test('normalizes secure control-plane origins', () => {
  assert.equal(__test.normalizeControlUrl('runner.example.com'), 'https://runner.example.com');
  assert.equal(__test.normalizeControlUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.throws(() => __test.normalizeControlUrl('http://runner.example.com'), /must use HTTPS/);
  assert.throws(() => __test.normalizeControlUrl('https://user:pass@runner.example.com'), /must not include credentials/);
});

test('reports external and custom runner capabilities', () => {
  const capabilities = __test.runnerCapabilities({ plugins: { enabled: ['devmate.godot'] } }, { capabilities: 'linux-x64,cuda' });
  for (const capability of ['core', 'external', 'godot', 'browser-qa', 'linux-x64', 'cuda']) {
    assert.equal(capabilities.includes(capability), true);
  }
});

test('detects local MCP error results', () => {
  const error = __test.toolError({ isError: true, content: [{ type: 'text', text: 'validation failed' }] });
  assert.match(error.message, /validation failed/);
  assert.equal(__test.toolError({ isError: false }), null);
});
