import assert from 'node:assert/strict';
import test from 'node:test';
import {
  booleanFlag,
  integerOption,
  integerValue,
  jobTimeout,
  parseRunnerArgs,
  stringValue
} from '../scripts/runner-options.mjs';

test('Runner CLI rejects unknown, duplicate, positional, and valueless options', () => {
  assert.throws(() => parseRunnerArgs(['unexpected']), /Unexpected Runner argument/);
  assert.throws(() => parseRunnerArgs(['--unknown']), /Unknown Runner option/);
  assert.throws(() => parseRunnerArgs(['--config']), /requires a value/);
  assert.throws(() => parseRunnerArgs(['--config', 'a.json', '--config', 'b.json']), /more than once/);
});

test('Runner CLI parses flags and value options without boolean coercion', () => {
  assert.deepEqual(parseRunnerArgs([
    '--config', 'runner.json',
    '--control-url', 'https://example.test',
    '--concurrency', '2',
    '--once'
  ]), {
    config: 'runner.json',
    'control-url': 'https://example.test',
    concurrency: '2',
    once: true
  });
  assert.throws(() => parseRunnerArgs(['--once', 'false']), /Unexpected Runner argument/);
});

test('Runner numeric options reject clamping and coercion', () => {
  assert.equal(integerOption(undefined, 2, 1, 16, '--concurrency'), 2);
  assert.equal(integerOption('2', 1, 1, 16, '--concurrency'), 2);
  assert.throws(() => integerOption('2.5', 1, 1, 16, '--concurrency'), /integer from 1 to 16/);
  assert.throws(() => integerOption('0', 1, 1, 16, '--concurrency'), /integer from 1 to 16/);
  assert.throws(() => integerOption('17', 1, 1, 16, '--concurrency'), /integer from 1 to 16/);
  assert.throws(() => integerValue('2', 1, 1, 16, 'runtime.maxConcurrentJobs'), /integer from 1 to 16/);
});

test('Runner flags and strings reject explicit wrong values', () => {
  assert.equal(booleanFlag(undefined, '--once'), false);
  assert.equal(booleanFlag(true, '--once'), true);
  assert.throws(() => booleanFlag('false', '--once'), /does not accept a value/);
  assert.equal(stringValue(' value ', undefined, '--config'), 'value');
  assert.throws(() => stringValue(true, undefined, '--config'), /non-empty string/);
  assert.throws(() => stringValue('', undefined, '--config'), /non-empty string/);
});

test('remote job timeout must be an actual bounded integer', () => {
  assert.equal(jobTimeout(undefined), 900000);
  assert.equal(jobTimeout(1000), 1000);
  assert.equal(jobTimeout(3600000), 3600000);
  assert.throws(() => jobTimeout('1000'), /timeoutMs/);
  assert.throws(() => jobTimeout(999), /timeoutMs/);
  assert.throws(() => jobTimeout(3600001), /timeoutMs/);
});
