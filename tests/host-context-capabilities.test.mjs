import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../gateway/host-context-capabilities.mjs';

test('host contexts are ordered by freshness and active context is selected', () => {
  const config = {
    activeHostId: 'obsidian',
    hostContexts: {
      vscode: { hostId: 'vscode', updatedAt: '2026-08-04T10:00:00.000Z', activeEditor: { path: 'app.js' } },
      obsidian: { hostId: 'obsidian', updatedAt: '2026-08-04T11:00:00.000Z', activeDocument: { path: 'Project.md' } }
    }
  };
  assert.deepEqual(__test.contextEntries(config).map(item => item.id), ['obsidian', 'vscode']);
  assert.equal(__test.selectContext(config).activeDocument.path, 'Project.md');
  assert.equal(__test.selectContext(config, 'vscode').activeEditor.path, 'app.js');
});

test('oversized contexts are bounded', () => {
  const bounded = __test.bounded({ text: 'x'.repeat(260000) });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.originalChars > 250000, true);
});
