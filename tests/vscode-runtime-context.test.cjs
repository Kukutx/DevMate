'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createRuntimeContext,
  currentWorkspaceRoot,
  gatewayCandidates,
  resolveVscodeStateDirectory,
  runtimeConfigPath,
  workspaceFolders
} = require('../vscode-host/runtime-context.js');
const { defaultSharedStateDirectory } = require('../host/runtime/state-paths.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeVscode(root, settings = {}) {
  return {
    Uri: { file(fsPath) { return { fsPath }; } },
    workspace: {
      workspaceFolders: root ? [{ name: path.basename(root), index: 0, uri: { fsPath: root } }] : [],
      getConfiguration() {
        return { get(name) { return settings[name]; } };
      }
    }
  };
}

test('resolves a shared VS Code state directory from the workspace root', () => {
  const root = temporaryDirectory('devmate-vscode-root-');
  const local = temporaryDirectory('devmate-vscode-local-');
  const shared = temporaryDirectory('devmate-vscode-shared-');
  const vscode = fakeVscode(root, { sharedStateDirectory: shared });
  const context = {
    globalStorageUri: { fsPath: local },
    extensionPath: root,
    marker() { return this; }
  };
  assert.equal(currentWorkspaceRoot(vscode), root);
  assert.equal(resolveVscodeStateDirectory(vscode, context), shared);
  const runtime = createRuntimeContext(vscode, context);
  assert.equal(runtime.globalStorageUri.fsPath, shared);
  assert.equal(runtime.marker(), context);
  assert.equal(runtimeConfigPath(runtime), path.join(shared, 'config.json'));
  assert.deepEqual(workspaceFolders(vscode), [{ name: path.basename(root), path: root, index: 0 }]);
});

test('uses one machine-wide desktop state by default across workspace roots', () => {
  const first = temporaryDirectory('devmate-vscode-first-');
  const second = temporaryDirectory('devmate-vscode-second-');
  const home = temporaryDirectory('devmate-vscode-home-');
  assert.equal(defaultSharedStateDirectory(first, { homeDirectory: home }), path.join(home, '.devmate', 'desktop'));
  assert.equal(defaultSharedStateDirectory(second, { homeDirectory: home }), path.join(home, '.devmate', 'desktop'));
});

test('uses extension storage only when no workspace is open', () => {
  const local = temporaryDirectory('devmate-vscode-local-');
  const context = { globalStorageUri: { fsPath: local }, extensionPath: local };
  assert.equal(resolveVscodeStateDirectory(fakeVscode('', {}), context), local);
});

test('uses only the packaged Gateway bundle at runtime', () => {
  const extensionPath = temporaryDirectory('devmate-vscode-extension-');
  const context = { extensionPath };
  assert.deepEqual(gatewayCandidates(context), [path.join(extensionPath, 'gateway', 'server.bundle.mjs')]);
});
