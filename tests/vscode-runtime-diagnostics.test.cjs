'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { VscodeRuntimeDiagnostics } = require('../vscode-host/runtime-diagnostics.js');

function temp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function harness(resolveNodeRuntimeImpl) {
  const extensionPath = temp('devmate-runtime-diagnostics-extension-');
  const stateDirectory = temp('devmate-runtime-diagnostics-state-');
  const workspaceRoot = temp('devmate-runtime-diagnostics-workspace-');
  const gatewayEntry = path.join(extensionPath, 'gateway', 'server.bundle.mjs');
  fs.mkdirSync(path.dirname(gatewayEntry), { recursive: true });
  fs.writeFileSync(gatewayEntry, 'x'.repeat(120000));
  const context = {
    extensionPath,
    extension: { packageJSON: { version: '3.3.0' } },
    globalStorageUri: { fsPath: stateDirectory }
  };
  const vscode = {
    version: '1.132.0-test',
    workspace: {
      workspaceFolders: [{ name: 'workspace', index: 0, uri: { fsPath: workspaceRoot } }],
      workspaceFile: null
    },
    env: { clipboard: { async writeText() {} } }
  };
  return {
    diagnostics: new VscodeRuntimeDiagnostics({
      vscode,
      context,
      runtimeContext: context,
      output: { appendLine() {} },
      resolveNodeRuntimeImpl
    }),
    gatewayEntry
  };
}

test('VS Code self-check fails when the actual Gateway Node runtime probe fails', () => {
  const { diagnostics } = harness(() => { throw new Error('no usable Node runtime'); });
  const result = diagnostics.selfCheck();
  assert.equal(result.ok, false);
  const runtime = result.checks.find(item => item.id === 'gateway-node-runtime');
  assert.equal(runtime.ok, false);
  assert.match(runtime.detail, /no usable Node runtime/);
});

test('VS Code self-check probes the exact Gateway artifact it reports', () => {
  let probeOptions = null;
  const { diagnostics, gatewayEntry } = harness(options => {
    probeOptions = options;
    return {
      source: 'path',
      executable: 'C:\\Program Files\\nodejs\\node.exe',
      nodeVersion: '24.18.0',
      electronVersion: null
    };
  });
  const result = diagnostics.selfCheck();
  assert.equal(result.ok, true);
  assert.equal(result.gatewayRuntime.source, 'path');
  assert.equal(result.gatewayRuntime.nodeVersion, '24.18.0');
  assert.equal(path.resolve(probeOptions.gatewayEntry), path.resolve(gatewayEntry));
  assert.equal(path.resolve(result.gateway), path.resolve(gatewayEntry));
});
