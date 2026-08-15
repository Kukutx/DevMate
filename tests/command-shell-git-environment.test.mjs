import assert from 'node:assert/strict';
import test from 'node:test';
import { commandEnvironment } from '../gateway/command-process.mjs';

test('shell commands disable interactive Git prompts for nested Git subprocesses', () => {
  const env = commandEnvironment('npm run release', {
    PATH: process.env.PATH || '',
    GIT_TERMINAL_PROMPT: '1',
    GCM_INTERACTIVE: 'Always'
  }, true);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'Never');
});

test('non-shell non-Git commands preserve unrelated Git environment defaults', () => {
  const env = commandEnvironment(process.execPath, { SAMPLE: 'kept' });
  assert.equal(env.SAMPLE, 'kept');
  assert.equal(env.GIT_TERMINAL_PROMPT, undefined);
  assert.equal(env.GCM_INTERACTIVE, undefined);
});
