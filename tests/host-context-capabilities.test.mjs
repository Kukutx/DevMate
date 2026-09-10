import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/host-context-capabilities.mjs';

test('host contexts are ordered by freshness and focused context is preferred', () => {
  const config = {
    activeHostId: 'obsidian',
    hostRuntime: { focusedHostId: 'vscode' },
    hostContexts: {
      vscode: { hostId: 'vscode', focused: true, updatedAt: '2026-08-04T10:00:00.000Z', activeEditor: { path: 'app.js' } },
      obsidian: { hostId: 'obsidian', focused: false, updatedAt: '2026-08-04T11:00:00.000Z', activeDocument: { path: 'Project.md' } }
    }
  };
  assert.deepEqual(__test.contextEntries(config).map(item => item.id), ['obsidian', 'vscode']);
  assert.equal(__test.selectContext(config).activeEditor.path, 'app.js');
  assert.equal(__test.selectContext(config, 'obsidian').activeDocument.path, 'Project.md');
});

test('active context remains the fallback when no focused host is registered', () => {
  const config = {
    activeHostId: 'obsidian',
    hostRuntime: {},
    hostContexts: {
      vscode: { hostId: 'vscode', updatedAt: '2026-08-04T12:00:00.000Z', activeEditor: { path: 'app.js' } },
      obsidian: { hostId: 'obsidian', updatedAt: '2026-08-04T11:00:00.000Z', activeDocument: { path: 'Project.md' } }
    }
  };
  assert.equal(__test.selectContext(config).activeDocument.path, 'Project.md');
});

test('oversized contexts are bounded', () => {
  const bounded = __test.bounded({ text: 'x'.repeat(260000) });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.originalChars > 250000, true);
});
