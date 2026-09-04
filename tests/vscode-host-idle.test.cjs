'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VscodeHostLifecycle } = require('../vscode-host/lifecycle.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function disposable() {
  return { dispose() {} };
}

test('VS Code host stays idle without a workspace instead of failing shared-config activation', async t => {
  const extensionPath = temporaryDirectory('devmate-vscode-idle-extension-');
  const stateDirectory = temporaryDirectory('devmate-vscode-idle-state-');
  const localStorage = temporaryDirectory('devmate-vscode-idle-local-');
  const warnings = [];
  let workspaceChange = null;
  let activateCalls = 0;
  let deactivateCalls = 0;

  const settings = {
    autoStart: true,
    sharedStateDirectory: stateDirectory,
    authenticationMode: 'none'
  };
  const output = { appendLine() {}, show() {}, dispose() {} };
  const vscode = {
    version: '1.133.0-test',
    Uri: { file(fsPath) { return { fsPath }; } },
    env: { clipboard: { async writeText() {} } },
    commands: {
      registerCommand() { return disposable(); },
      async executeCommand() {}
    },
    window: {
      createOutputChannel() { return output; },
      async showInformationMessage() {},
      async showWarningMessage(message) { warnings.push(message); },
      async showErrorMessage() {},
      async showTextDocument() {}
    },
    workspace: {
      workspaceFolders: [],
      workspaceFile: null,
      getConfiguration() {
        return {
          get(name) { return settings[name]; },
          async update(name, value) { settings[name] = value; }
        };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders(callback) { workspaceChange = callback; return disposable(); },
      async openTextDocument(file) { return { fileName: file }; }
    }
  };
  const context = {
    extensionPath,
    extension: { packageJSON: { version: '3.6.5' } },
    globalStorageUri: { fsPath: localStorage },
    subscriptions: [],
    secrets: { async get() { return ''; } }
  };
  const platform = {
    async activate() { activateCalls += 1; },
    async deactivate() { deactivateCalls += 1; }
  };
  const lifecycle = new VscodeHostLifecycle({ vscode, platformExtension: platform });
  t.after(() => {
    fs.rmSync(extensionPath, { recursive: true, force: true });
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(localStorage, { recursive: true, force: true });
  });

  const result = await lifecycle.activate(context);
  assert.deepEqual(result, { idle: true, reason: 'no-workspace' });
  assert.equal(lifecycle.active, true);
  assert.equal(lifecycle.platformActivated, false);
  assert.equal(lifecycle.platformActivationAttempted, false);
  assert.equal(activateCalls, 0);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'config.json')), false);
  assert.equal(typeof workspaceChange, 'function');

  const projectRoot = temporaryDirectory('devmate-vscode-idle-project-');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  vscode.workspace.workspaceFolders = [{ name: path.basename(projectRoot), index: 0, uri: { fsPath: projectRoot } }];
  workspaceChange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings.some(message => message.includes('primary workspace changed')), true);

  await lifecycle.deactivate();
  assert.equal(deactivateCalls, 0);
  assert.equal(lifecycle.active, false);
});
