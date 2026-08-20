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
  fs.mkdirSync(path.join(extensionPath, 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(extensionPath, 'gateway', 'server.bundle.mjs'), 'export {};\n');
  const context = {
    extensionPath,
    extension: { packageJSON: { version: '3.5.0-test' } },
    globalStorageUri: { fsPath: stateDirectory }
  };
  const vscode = {
    version: '1.133.0-test',
    workspace: {
      workspaceFolders: [{ name: 'workspace', index: 0, uri: { fsPath: workspaceRoot } }],
      workspaceFile: null
    },
    env: { clipboard: { async writeText() {} } }
  };
  const diagnostics = new VscodeRuntimeDiagnostics({
    vscode,
    context,
    runtimeContext: context,
    output: { appendLine() {} },
    resolveNodeRuntimeImpl
  });
  return { diagnostics, extensionPath, stateDirectory, workspaceRoot };
}

test('VS Code self-check fails when the actual Gateway Node runtime probe fails', () => {
  const { diagnostics } = harness(() => { throw new Error('no usable Node runtime'); });
  const result = diagnostics.selfCheck();
  assert.equal(result.ok, false);
  const runtime = result.checks.find(item => item.id === 'gateway-node-runtime');
  assert.equal(runtime.ok, false);
  assert.match(runtime.detail, /no usable Node runtime/);
});

test('VS Code self-check reports the exact selected Gateway runtime without bundle-size heuristics', () => {
  const { diagnostics } = harness(() => ({
    source: 'path',
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    nodeVersion: '24.19.0',
    electronVersion: null
  }));
  const result = diagnostics.selfCheck();
  assert.equal(result.ok, true);
  assert.equal(result.gatewayRuntime.source, 'path');
  assert.equal(result.gatewayRuntime.nodeVersion, '24.19.0');
  assert.equal(result.checks.some(item => item.id === 'gateway-bundle-size'), false);
});

test('VS Code diagnostics surface durable startup and degraded state health markers', () => {
  const { diagnostics, stateDirectory } = harness(() => ({
    source: 'path', executable: 'node', nodeVersion: '24.19.0', electronVersion: null
  }));
  const stateRoot = path.join(stateDirectory, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'gateway-startup.json'), JSON.stringify({ status: 'starting', currentStage: 'maintenance' }));
  fs.writeFileSync(path.join(stateRoot, 'audit-health.json'), JSON.stringify({ status: 'degraded', error: { code: 'EIO' } }));
  fs.writeFileSync(path.join(stateRoot, 'runtime-maintenance.json'), JSON.stringify({ status: 'degraded', error: { code: 'EPERM' } }));

  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.startupProgress.currentStage, 'maintenance');
  assert.equal(snapshot.auditHealth.error.code, 'EIO');
  assert.equal(snapshot.runtimeMaintenanceHealth.error.code, 'EPERM');
});
