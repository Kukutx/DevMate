import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../gateway/plugins/browser-runner.mjs';

test('Browser QA accepts only browser-shaped executable names', () => {
  assert.equal(__test.browserExecutableAllowed('/Applications/Google Chrome'), true);
  assert.equal(__test.browserExecutableAllowed('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), true);
  assert.equal(__test.browserExecutableAllowed('/tmp/arbitrary-shell'), false);
  assert.equal(__test.browserExecutableAllowed('/tmp/chrome-malware'), false);
});

test('Browser QA blocks remote URLs by default', () => {
  assert.throws(() => __test.assertAllowedUrl('https://example.com', false), /Remote browser URLs are disabled/);
  assert.equal(__test.assertAllowedUrl('http://127.0.0.1:3000', false).hostname, '127.0.0.1');
});

test('Browser QA output and configured modules cannot escape through workspace symlinks', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-browser-workspace-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-browser-outside-'));
  const link = path.join(workspace, 'escape');
  try {
    fs.writeFileSync(path.join(outside, 'playwright.mjs'), 'export const chromium = {};\n');
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    assert.throws(
      () => __test.safeWorkspaceOutput(workspace, 'escape/screenshot.png', 'Screenshot'),
      /workspace root through symlink/i
    );
    assert.throws(
      () => __test.resolveModuleFromWorkspace(workspace, 'escape/playwright.mjs'),
      /workspace root through symlink/i
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
