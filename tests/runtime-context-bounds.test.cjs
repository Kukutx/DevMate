'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeController } = require('../host/runtime/process-controller.js');
const { MAX_HOST_CONTEXT_CHARS } = require('../shared/host-registry.cjs');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('RuntimeController bounds oversized context without dropping focus identity', () => {
  const workspaceRoot = temporaryDirectory('devmate-context-bound-workspace-');
  const stateDirectory = temporaryDirectory('devmate-context-bound-state-');
  const gatewayEntry = path.join(stateDirectory, 'gateway.mjs');
  fs.writeFileSync(gatewayEntry, 'export {};\n', 'utf8');
  const controller = new RuntimeController({
    workspaceRoot,
    stateDirectory,
    gatewayEntry,
    hostId: 'vscode-large-context'
  });

  try {
    controller.ensureConfig();
    controller.updateHostContext({
      focused: true,
      kind: 'editor',
      activeEditor: { path: 'large.txt', selectedText: 'x'.repeat(MAX_HOST_CONTEXT_CHARS + 50000) }
    });
    const config = controller.readConfig();
    const context = config.hostContexts['vscode-large-context'];
    assert.ok(JSON.stringify(context).length <= MAX_HOST_CONTEXT_CHARS);
    assert.equal(context.truncated, true);
    assert.equal(context.focused, true);
    assert.equal(context.kind, 'editor');
    assert.equal(context.workspaceRoot, workspaceRoot);
    assert.equal(config.hostRuntime.focusedHostId, 'vscode-large-context');
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
