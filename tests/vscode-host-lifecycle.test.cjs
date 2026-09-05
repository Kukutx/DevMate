'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readLifecycleIntent, setLifecycleIntent } = require('../shared/lifecycle-intent.cjs');
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
    sharedStateDirectory: stateDirectory,
    authenticationMode: 'oauth'
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
      getConfiguration() {
        return {
          get(name) { return settings[name]; },
          async update(name, value) { settings[name] = value; }
        };
      },
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
  return { context, lifecycle, registered, settings, stateDirectory, configFile: path.join(stateDirectory, 'config.json') };
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
  setLifecycleIntent(harness.configFile, 'running', { requestedBy: 'test', reason: 'session-active' });
  const before = readLifecycleIntent(harness.configFile);

  await harness.lifecycle.deactivate();

  const after = readLifecycleIntent(harness.configFile);
  assert.deepEqual(deactivationOptions, { preserveSession: true });
  assert.equal(after.desiredState, 'running');
  assert.equal(after.generation, before.generation);
});

test('host handoff never reconstructs running intent after an inner authoritative stop', async () => {
  let configFile = '';
  const platform = {
    async activate() {},
    async deactivate() {
      setLifecycleIntent(configFile, 'stopped', { requestedBy: 'inner', reason: 'cleanup-during-handoff' });
    }
  };
  const harness = createHarness({ platform });
  configFile = harness.configFile;
  await harness.lifecycle.activate(harness.context);
  setLifecycleIntent(configFile, 'running', { requestedBy: 'test', reason: 'session-active' });
  const before = readLifecycleIntent(configFile);

  await harness.lifecycle.deactivate({ preserveSession: true });

  const after = readLifecycleIntent(configFile);
  assert.equal(before.desiredState, 'running');
  assert.equal(after.desiredState, 'stopped');
  assert.ok(after.generation > before.generation);
  assert.equal(after.requestedBy, 'inner');
  assert.equal(after.reason, 'cleanup-during-handoff');
});

test('host handoff never resurrects a session that was already explicitly stopped', async () => {
  let configFile = '';
  const platform = {
    async activate() {},
    async deactivate() {
      setLifecycleIntent(configFile, 'stopped', { requestedBy: 'inner', reason: 'cleanup' });
    }
  };
  const harness = createHarness({ platform });
  configFile = harness.configFile;
  await harness.lifecycle.activate(harness.context);
  setLifecycleIntent(configFile, 'stopped', { requestedBy: 'user', reason: 'explicit-stop' });

  await harness.lifecycle.deactivate({ preserveSession: true });

  assert.equal(readLifecycleIntent(configFile).desiredState, 'stopped');
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

test('automatic Start stays visible as pending until the Start command settles', async () => {
  const platform = {
    async activate() {},
    async deactivate() {}
  };
  const harness = createHarness({ platform });
  harness.settings.autoStart = true;
  let resolveStart = null;
  let startCalls = 0;
  harness.lifecycle.vscode.commands.executeCommand = async id => {
    if (id !== 'devMate.start') return undefined;
    startCalls += 1;
    return new Promise(resolve => {
      resolveStart = resolve;
    });
  };

  await harness.lifecycle.activate(harness.context);
  for (let attempt = 0; !resolveStart && attempt < 50; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.equal(startCalls, 1);
  assert.equal(typeof resolveStart, 'function');
  assert.equal(harness.lifecycle.startupPending(), true);

  resolveStart({ ok: false, recovering: true });
  for (let attempt = 0; harness.lifecycle.startupPending() && attempt < 50; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.equal(harness.lifecycle.startupPending(), false);
  await harness.lifecycle.deactivate();
});

test('verified shared-session recovery clears a stale automatic Start failure', async () => {
  const platform = {
    async activate() {},
    async deactivate() {}
  };
  const harness = createHarness({ platform });
  await harness.lifecycle.activate(harness.context);
  harness.lifecycle.diagnostics.store.recordFailure(
    Object.assign(new Error('synthetic startup failure'), { code: 'START_FAIL' }),
    { phase: 'automatic-start' }
  );

  assert.equal(harness.lifecycle.diagnostics.store.lastFailure?.code, 'START_FAIL');
  harness.lifecycle.markRecoveredStart({ toolCount: 142 });
  assert.equal(harness.lifecycle.diagnostics.store.lastFailure, null);
  assert.match(harness.lifecycle.diagnostics.store.tail(20), /Shared session recovery reached verified Ready state; tools=142/);
  await harness.lifecycle.deactivate();
});
