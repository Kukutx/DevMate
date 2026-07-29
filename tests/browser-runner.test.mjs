import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/plugins/browser-runner.mjs';

test('Browser QA accepts only browser-shaped executable names', () => {
  assert.equal(__test.browserExecutableAllowed('/Applications/Google Chrome'), true);
  assert.equal(__test.browserExecutableAllowed('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), true);
  assert.equal(__test.browserExecutableAllowed('/tmp/arbitrary-shell'), false);
});

test('Browser QA blocks remote URLs by default', () => {
  assert.throws(() => __test.assertAllowedUrl('https://example.com', false), /Remote browser URLs are disabled/);
  assert.equal(__test.assertAllowedUrl('http://127.0.0.1:3000', false).hostname, '127.0.0.1');
});
