'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { contextSignature } = require('../vscode-host/context-mirror.js');

test('VS Code context mirroring ignores timestamp-only churn', () => {
  const base = { workspaceRoot: 'C:/repo', activeEditor: { path: 'a.js' }, visibleEditors: [{ path: 'a.js' }], diagnostics: [] };
  assert.equal(contextSignature({ ...base, capturedAt: '2026-01-01T00:00:00Z' }), contextSignature({ ...base, capturedAt: '2026-01-01T00:00:01Z', updatedAt: 'later' }));
  assert.notEqual(contextSignature(base), contextSignature({ ...base, activeEditor: { path: 'b.js' } }));
});

test('context mirror does not log successful mirrors into the same Output surface it observes', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'vscode-host', 'context-mirror.js'), 'utf8');
  assert.doesNotMatch(source, /Mirrored VS Code editor context into shared host context/);
});
