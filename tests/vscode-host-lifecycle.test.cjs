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

function createHarness({ platform }) {
  const extensionPath = temporaryDirectory('devmate-vscode-lifecycle-extension-');
  const workspaceRoot = temporaryDirectory('devmate-vscode-lifecycle-workspace-');
  const stateDirectory = temporaryDirectory('devmate-vscode-lifecycle-state-');
  fs.mkdirSync(path.join(extensionPath, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'gateway', 'server.bundle.mjs'), 'x'.repeat(120000));

  const settings = {
    vscodeHostEnabled: true,
    vscodeStartupMode: 'manual',
    sharedRuntimeEnabled: false
  };
  const registered = [];
  const output = { appendLine() {}, show() {}, dispose() {} };
  const vscode = {
    version: '1.100.0-test',
    Uri: { file(fsPath) { return { fsPath }; } },
    env: { clipboard: { async writeText() {} } },
    commands: {
      registerCommand(id) { registered.push(id); return disposable(); },
      async executeCommand() {}
    },
    window: {
      createOutputChannel() { return output; },
      async showInformationMessage() {},
      async showWarningMessage() {},
      async showErrorMessage() {},
      async showTextDocument() {}
    },
    workspace: {
      workspaceFolders: [{ name: path.basename(workspaceRoot), index: 0, uri: { fsPath: workspaceRoot } }],
      workspaceFile: null,
      getConfiguration() { return { get(name) { return settings[name]; } }; },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
      async openTextDocument(file) { return { fileName: file }; }
    }
  };
  const context = {
    extensionPath,
    extension: { packageJSON: { version: '3.0.1' } },
    globalStorageUri: { fsPath: stateDirectory },
    subscriptions: [],
    secrets: { async get() { return ''; } }
  };
  const originalSpawn = function originalSpawn() { return { delegated: true }; };
  const childProcessModule = { spawn: originalSpawn };
  const lifecycle = new VscodeHostLifecycle({
    vscode,
    platformExtension: platform,
    childProcessModule
  });
  return { childProcessModule, context, lifecycle, originalSpawn, registered, stateDirectory };
}

test('rolls back platform and spawn state when VS Code host activation fails', async () => {
  let deactivateCalls = 0;
  const platform = {
    async activate() { throw Object.assign(new Error('synthetic platform activation failure'), { code: 'PLATFORM_FAIL' }); },
    async deactivate() { deactivateCalls += 1; }
  };
  const harness = createHarness({ platform });
  await assert.rejects(harness.lifecycle.activate(harness.context), /synthetic platform activation failure/);
  assert.equal(deactivateCalls, 1);
  assert.equal(harness.childProcessModule.spawn, harness.originalSpawn);
  assert.equal(harness.lifecycle.router, null);
  assert.equal(harness.lifecycle.runtimeContext, null);
  assert.equal(harness.lifecycle.context, null);
  assert.equal(harness.lifecycle.platformActivationAttempted, false);
  assert.ok(fs.existsSync(path.join(harness.stateDirectory, 'logs', 'vscode-host.log')));
});

test('activates in manual mode, exposes host commands, and restores state on deactivate', async () => {
  let activateCalls = 0;
  let deactivateCalls = 0;
  const platform = {
    async activate() { activateCalls += 1; },
    async deactivate() { deactivateCalls += 1; }
  };
  const harness = createHarness({ platform });
  await harness.lifecycle.activate(harness.context);
  assert.equal(activateCalls, 1);
  assert.equal(harness.lifecycle.active, true);
  assert.equal(harness.lifecycle.router.mode, 'worker_threads');
  assert.ok(harness.registered.includes('devMate.copyHostDiagnostics'));
  assert.ok(harness.registered.includes('devMate.hostSelfCheck'));
  await harness.lifecycle.deactivate();
  assert.equal(deactivateCalls, 1);
  assert.equal(harness.childProcessModule.spawn, harness.originalSpawn);
  assert.equal(harness.lifecycle.active, false);
  assert.equal(harness.lifecycle.router, null);
});
