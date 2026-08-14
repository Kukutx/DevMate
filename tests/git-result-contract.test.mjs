import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/team-capabilities.mjs';

const { markGitFailure } = __test;

function toolResult(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent
  };
}

test('successful Git results remain successful MCP tool results', () => {
  const result = toolResult({ exitCode: 0, stdout: '## master...origin/master', stderr: '' });
  assert.equal(markGitFailure('git_status', result), result);
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.ok, undefined);
});

test('direct Git subprocess failure is surfaced as MCP isError', () => {
  const result = toolResult({ exitCode: 1, stdout: '', stderr: 'fatal: failure' });
  markGitFailure('git_push', result);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.failedPhase, 'command');
  assert.match(result.content[0].text, /"failedPhase": "command"/);
});

test('git_save reports the exact failed nested phase', () => {
  const result = toolResult({
    stage: { exitCode: 0, stdout: '', stderr: '' },
    commit: { exitCode: 0, stdout: '[master abc] save', stderr: '' },
    push: { exitCode: 128, stdout: '', stderr: "fatal: 'missing-remote' does not appear to be a git repository" },
    status: { exitCode: 0, stdout: '## master...origin/master [ahead 1]', stderr: '' }
  });
  markGitFailure('git_save', result);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.failedPhase, 'push');
  assert.match(result.content[0].text, /"failedPhase": "push"/);
});

test('non-Git tool results are never reclassified', () => {
  const result = toolResult({ exitCode: 1, error: 'application-level result' });
  markGitFailure('run_command', result);
  assert.notEqual(result.isError, true);
  assert.equal(result.structuredContent.failedPhase, undefined);
});
