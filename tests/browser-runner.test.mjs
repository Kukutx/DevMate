import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../gateway/plugins/browser-runner.mjs';
import { __test as browserQaTest } from '../gateway/plugins/browser-qa.mjs';

test('Browser QA accepts only browser-shaped executable names', () => {
  assert.equal(__test.browserExecutableAllowed('/Applications/Google Chrome'), true);
  assert.equal(__test.browserExecutableAllowed('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), true);
  assert.equal(__test.browserExecutableAllowed('/tmp/arbitrary-shell'), false);
  assert.equal(__test.browserExecutableAllowed('/tmp/chrome-malware'), false);
});

test('Browser QA blocks remote URLs by default', () => {
  assert.throws(() => __test.assertAllowedUrl('https://example.com', false), /Remote browser URLs are disabled/);
  assert.equal(__test.assertAllowedUrl('http://127.0.0.1:3000', false).hostname, '127.0.0.1');
  assert.equal(__test.assertAllowedUrl('http://127.2.3.4:3000', false).hostname, '127.2.3.4');
  assert.doesNotThrow(() => __test.assertAllowedUrl('http://[::1]:3000', false));
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

test('Browser QA artifact outputs cannot target protected workspace data', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-browser-protected-'));
  try {
    fs.mkdirSync(path.join(workspace, '.aws'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.devmate'), { recursive: true });
    assert.throws(
      () => __test.safeWorkspaceOutput(workspace, '.npmrc', 'Report'),
      /protected workspace data/i
    );
    assert.throws(
      () => __test.safeWorkspaceOutput(workspace, '.aws/credentials', 'Screenshot'),
      /protected workspace data/i
    );
    assert.throws(
      () => __test.safeWorkspaceOutput(workspace, '.devmate/state.json', 'Report'),
      /protected workspace data/i
    );
    assert.doesNotThrow(() => __test.safeWorkspaceOutput(workspace, 'artifacts/browser-qa/latest.json', 'Report'));
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Browser QA plugin service accepts only uniquely configured workspace roots', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-browser-service-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-browser-service-outside-'));
  try {
    const context = {
      readConfig: () => ({ workspaces: [{ id: 'main', root: workspace }] }),
      workspace: {
        get(id, options) {
          assert.equal(id, 'main');
          return { id, root: workspace, writable: !!options?.writable };
        }
      }
    };
    const resolved = browserQaTest.serviceWorkspaceFromRoot(context, workspace, { writable: true });
    assert.equal(resolved.id, 'main');
    assert.equal(resolved.writable, true);
    assert.throws(
      () => browserQaTest.serviceWorkspaceFromRoot(context, outside),
      error => error?.code === 'browser_qa_workspace_boundary'
    );

    const duplicateContext = {
      ...context,
      readConfig: () => ({ workspaces: [{ id: 'a', root: workspace }, { id: 'b', root: workspace }] })
    };
    assert.throws(
      () => browserQaTest.serviceWorkspaceFromRoot(duplicateContext, workspace),
      error => error?.code === 'browser_qa_workspace_boundary'
    );
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('Browser QA preview roots cannot point at protected workspace directories', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-browser-preview-root-'));
  try {
    fs.mkdirSync(path.join(workspaceRoot, 'build', 'web'), { recursive: true });
    fs.mkdirSync(path.join(workspaceRoot, '.aws'), { recursive: true });
    const workspace = { id: 'main', root: workspaceRoot };
    const context = {
      workspace: {
        resolve(_workspace, value) {
          const target = path.resolve(workspaceRoot, value);
          const relative = path.relative(workspaceRoot, target);
          if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('escape');
          return target;
        }
      }
    };
    assert.equal(
      browserQaTest.resolvePreviewRoot(context, workspace, 'build/web'),
      path.join(workspaceRoot, 'build', 'web')
    );
    assert.throws(
      () => browserQaTest.resolvePreviewRoot(context, workspace, '.aws'),
      error => error?.code === 'preview_protected_root'
    );
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
