'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('VS Code Stop and teardown preserve Gateway whenever public connection release is unsafe', () => {
  const extension = source('extension.js');
  const stopStart = extension.indexOf('async function stopAll()');
  const stopEnd = extension.indexOf('async function restartAll', stopStart);
  const stop = extension.slice(stopStart, stopEnd);
  const publicGate = stop.indexOf('if(!tunnelAllowsGatewayShutdown(tunnel))');
  const gatewayStop = stop.indexOf('stopGatewayProcess()');
  assert.ok(publicGate >= 0 && gatewayStop > publicGate, 'Gateway shutdown must remain after the public connection safety gate');

  const deactivateStart = extension.indexOf('function deactivate({preserveSession=false}={})');
  const deactivate = extension.slice(deactivateStart);
  assert.match(deactivate, /host-deactivation-preserves-shared-session/);
  assert.match(deactivate, /dispose\(\{stopOwned:!preserveSession && tunnelAllowsGatewayShutdown\(stopped\?\.tunnel\)\}\)/);
  assert.match(deactivate, /if\(disposed\?\.disposed === false\)/);
});

test('failed VS Code Start preserves a newly owned Gateway under any pre-existing or attached public connection', () => {
  const extension = source('extension.js');
  const start = extension.indexOf('async function rollbackFailedStart');
  const end = extension.indexOf('async function quickStart', start);
  const block = extension.slice(start, end);
  assert.match(block, /!tunnelWasRunning && !\(tunnel\?\.attached && !tunnel\?\.owned\)/);
  assert.match(block, /tunnelAllowsGatewayShutdown\(stopped\)/);
  assert.match(block, /Preserving the newly owned Gateway/);
});

test('default start command uses process-tree termination and ignores Output text churn', () => {
  const extension = source('extension.js');
  assert.match(extension, /terminateProcessTree/);
  assert.match(extension, /detached: process\.platform !== 'win32'/);
  assert.doesNotMatch(extension, /function waitForProcessExit/);
  assert.match(extension, /onDidChangeTextEditorSelection\(event=>[\s\S]*scheme !== 'output'/);
  assert.match(extension, /onDidChangeTextDocument\(event=>[\s\S]*scheme !== 'output'/);
});

test('desktop runtime keeps one fixed Gateway port without passive host-version churn', () => {
  const network = source('host/runtime/network.js');
  const controller = source('host/runtime/process-controller.js');
  const gateway = source('gateway/server-runtime.mjs');
  const extension = source('extension.js');
  const sharedTunnel = source('extension-entry-shared-tunnel.js');
  const lifecycle = source('vscode-host/lifecycle.js');
  const obsidianSettings = source('obsidian-plugin/src/settings.js');

  assert.doesNotMatch(network, /base \+ 19|port \+= 1/);
  assert.match(network, /will not move to another port automatically/);
  assert.doesNotMatch(controller, /current\.server\.port = choice\.port/);
  assert.match(controller, /automatic port fallback is disabled/);
  assert.match(controller, /promoteConfigVersion/);
  assert.match(gateway, /startupRuntimeIdentity/);
  assert.match(gateway, /currentIdentity\.appVersion !== startupRuntimeIdentity\.appVersion/);
  assert.match(gateway, /currentIdentity\.port !== startupRuntimeIdentity\.port/);
  assert.match(gateway, /runtime-config-changed/);
  assert.doesNotMatch(extension, /data\.appVersion\s*=\s*VERSION/);
  assert.doesNotMatch(extension, /portOverride/);
  assert.match(extension, /const BASE_PORT = DEFAULT_PORT/);
  assert.match(sharedTunnel, /setting\(vscode, 'port', DEFAULT_PORT\)/);
  assert.match(sharedTunnel, /promoteAppVersion:\s*false/);
  assert.match(lifecycle, /setting\(this\.vscode, 'port', DEFAULT_PORT\)/);
  assert.match(lifecycle, /promoteAppVersion:\s*false/);
  assert.match(obsidianSettings, /preferredPort: DEFAULT_PORT/);
});
