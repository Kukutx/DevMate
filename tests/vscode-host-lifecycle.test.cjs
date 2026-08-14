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
    autoStart: false,
    sharedStateDirectory: stateDirectory
  };
  const registered = [];
  const output = { appendLine() {}, show() {}, dispose() {} };
  const vscode = {
    version: '1.132.0-test',
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
    extension: { packageJSON: { version: '3.3.0' } },
    globalStorageUri: { fsPath: temporaryDirectory('devmate-vscode-extension-storage-') },
    subscriptions: [],
    secrets: { async get() { return ''; } }
  };
  const lifecycle = new VscodeHostLifecycle({ vscode, platformExtension: platform });
  return { context, lifecycle, registered, stateDirectory };
}

test('rolls back platform state when VS Code host activation fails', async () => {
  let deactivateCalls = 0;
  const platform = {
    async activate() { throw Object.assign(new Error('synthetic platform activation failure'), { code: 'PLATFORM_FAIL' }); },
    async deactivate() { deactivateCalls += 1; }
  };
  const harness = createHarness({ platform });
  await assert.rejects(harness.lifecycle.activate(harness.context), /synthetic platform activation failure/);
  assert.equal(deactivateCalls, 1);
  assert.equal(harness.lifecycle.runtimeContext, null);
  assert.equal(harness.lifecycle.context, null);
  assert.equal(harness.lifecycle.platformActivationAttempted, false);
  assert.ok(fs.existsSync(path.join(harness.stateDirectory, 'logs', 'vscode-host.log')));
});

test('activates in manual mode with child-process runtime diagnostics and cleans up', async () => {
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
  assert.ok(harness.registered.includes('devMate.copyHostDiagnostics'));
  assert.ok(harness.registered.includes('devMate.hostSelfCheck'));
  const check = harness.lifecycle.runSelfCheck(false);
  assert.equal(check.ok, true);
  assert.equal(check.checks.find(item => item.id === 'gateway-launch-mode')?.detail, 'child_process');
  assert.equal(check.checks.find(item => item.id === 'gateway-node-runtime')?.ok, true);
  await harness.lifecycle.deactivate();
  assert.equal(deactivateCalls, 1);
  assert.equal(harness.lifecycle.active, false);
});

test('normal VS Code host shutdown preserves the shared DevMate session', async () => {
  let deactivationOptions = null;
  const platform = {
    async activate() {},
    async deactivate(options) { deactivationOptions = options; }
  };
  const harness = createHarness({ platform });
  await harness.lifecycle.activate(harness.context);
  await harness.lifecycle.deactivate();
  assert.deepEqual(deactivationOptions, { preserveSession: true });
});

test('activation rollback still requests a full platform cleanup', async () => {
  let deactivationOptions = null;
  const platform = {
    async activate() { throw new Error('synthetic activation failure'); },
    async deactivate(options) { deactivationOptions = options; }
  };
  const harness = createHarness({ platform });
  await assert.rejects(harness.lifecycle.activate(harness.context), /synthetic activation failure/);
  assert.deepEqual(deactivationOptions, { preserveSession: false });
});
