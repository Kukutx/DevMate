'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson, newInstanceConfig } = require('../shared/config-store.cjs');
const { VscodeHostLifecycle } = require('../vscode-host/lifecycle.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function disposable() {
  return { dispose() {} };
}

function createHarness({ existingConfig = false } = {}) {
  const extensionPath = temporaryDirectory('devmate-vscode-idle-extension-');
  const stateDirectory = temporaryDirectory('devmate-vscode-idle-state-');
  const localStorage = temporaryDirectory('devmate-vscode-idle-local-');
  const configWorkspace = temporaryDirectory('devmate-vscode-idle-config-workspace-');
  const warnings = [];
  let workspaceChange = null;
  let activateCalls = 0;
  let deactivateCalls = 0;

  if (existingConfig) {
    atomicWriteJson(path.join(stateDirectory, 'config.json'), newInstanceConfig({
      workspaceRoot: configWorkspace,
      appVersion: '3.6.5'
    }));
  }

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

  return {
    context,
    lifecycle,
    stateDirectory,
    warnings,
    vscode,
    cleanup() {
      for (const directory of [extensionPath, stateDirectory, localStorage, configWorkspace]) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    workspaceChange: () => workspaceChange,
    activateCalls: () => activateCalls,
    deactivateCalls: () => deactivateCalls
  };
}

test('VS Code host stays idle without a workspace instead of failing shared-config activation', async t => {
  const harness = createHarness();
  t.after(() => harness.cleanup());

  const result = await harness.lifecycle.activate(harness.context);
  assert.deepEqual(result, { idle: true, reason: 'no-workspace' });
  assert.equal(harness.lifecycle.active, true);
  assert.equal(harness.lifecycle.platformActivated, false);
  assert.equal(harness.lifecycle.platformActivationAttempted, false);
  assert.equal(harness.activateCalls(), 0);
  assert.equal(fs.existsSync(path.join(harness.stateDirectory, 'config.json')), false);
  assert.equal(typeof harness.workspaceChange(), 'function');

  const projectRoot = temporaryDirectory('devmate-vscode-idle-project-');
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
  harness.vscode.workspace.workspaceFolders = [{ name: path.basename(projectRoot), index: 0, uri: { fsPath: projectRoot } }];
  harness.workspaceChange()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.warnings.some(message => message.includes('primary workspace changed')), true);

  await harness.lifecycle.deactivate();
  assert.equal(harness.deactivateCalls(), 0);
  assert.equal(harness.lifecycle.active, false);
});

test('an existing shared desktop config still activates the platform without a workspace', async t => {
  const harness = createHarness({ existingConfig: true });
  t.after(() => harness.cleanup());

  const result = await harness.lifecycle.activate(harness.context);
  assert.equal(result, undefined);
  assert.equal(harness.lifecycle.active, true);
  assert.equal(harness.lifecycle.platformActivated, true);
  assert.equal(harness.lifecycle.platformActivationAttempted, true);
  assert.equal(harness.activateCalls(), 1);

  await harness.lifecycle.deactivate();
  assert.equal(harness.deactivateCalls(), 1);
  assert.equal(harness.lifecycle.active, false);
});
