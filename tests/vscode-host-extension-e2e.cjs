'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function run() {
  const extension = vscode.extensions.getExtension('local-ai.devmate');
  assert(extension, 'DevMate extension was not loaded in the VS Code Extension Host');
  await extension.activate();

  const selfCheck = await vscode.commands.executeCommand('devMate.hostSelfCheck');
  assert.equal(selfCheck?.ok, true, `DevMate Host Self-Check failed: ${JSON.stringify(selfCheck)}`);
  assert.equal(selfCheck?.gatewayRuntime?.source, 'path', `Expected standalone Node in real VS Code host, got ${JSON.stringify(selfCheck?.gatewayRuntime)}`);

  const extensionPath = extension.extensionPath;
  const { resolveNodeRuntime } = require(path.join(extensionPath, 'host', 'runtime', 'node-runtime.js'));
  const { RuntimeController } = require(path.join(extensionPath, 'host', 'runtime-controller.js'));
  const { updateConfig } = require(path.join(extensionPath, 'shared', 'config-store.cjs'));
  const { configureAuthentication } = require(path.join(extensionPath, 'shared', 'auth-config.cjs'));
  const { setLifecycleIntent } = require(path.join(extensionPath, 'shared', 'lifecycle-intent.cjs'));
  const runtime = resolveNodeRuntime();
  assert.equal(runtime.source, 'path');
  assert.match(runtime.nodeVersion, /^24\./);

  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-host-runtime-workspace-'));
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-host-runtime-state-'));
  const port = await freePort();
  const controller = new RuntimeController({
    workspaceRoot,
    stateDirectory,
    gatewayEntry: path.join(extensionPath, 'gateway', 'server.bundle.mjs'),
    preferredPort: port,
    appVersion: extension.packageJSON.version,
    defaultConnectionProvider: 'ngrok',
    hostId: 'vscode-extension-host-e2e',
    nodeExecutable: runtime.executable
  });

  try {
    // This test drives RuntimeController directly instead of the normal VS Code
    // Start wrapper. Establish the same explicit local-only lifecycle state first
    // so lifecycle fencing remains production-realistic.
    controller.ensureConfig();
    updateConfig(controller.configFile, config => {
      configureAuthentication(config, 'none', { replace: true });
      return config;
    });
    setLifecycleIntent(controller.configFile, 'running', {
      requestedBy: 'vscode-extension-host-e2e',
      reason: 'real extension host runtime ownership smoke'
    });

    const started = await controller.start({ timeoutMs: 10000 });
    assert.equal(started.started, true);
    assert.equal(started.owned, true);
    assert.equal(started.port, port);
    assert.equal(started.health?.name, 'devmate');
    assert.equal(started.health?.version, extension.packageJSON.version);

    const status = await controller.status();
    assert.equal(status.state, 'running');
    assert.equal(status.owned, true);
    assert.equal(status.port, port);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

module.exports = { run };
