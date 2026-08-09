'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('desktop hosts use the shared child-process Gateway controller', () => {
  const processController = source('host/runtime/process-controller.js');
  const vscodeLifecycle = source('vscode-host/lifecycle.js');
  const obsidian = source('obsidian-plugin/src/main.js');
  assert.match(processController, /class RuntimeController|class ProcessController/);
  assert.match(processController, /spawnImpl = spawn/);
  assert.match(vscodeLifecycle, /child-process runtime diagnostics|child_process/);
  assert.match(obsidian, /new RuntimeController/);
  assert.match(obsidian, /resolveNodeRuntime/);
});

test('Gateway uses the current DEVMATE_CONFIG instance contract', () => {
  assert.match(source('gateway/local-shared.mjs'), /DEVMATE_CONFIG/);
  assert.match(source('gateway/server.mjs'), /DEVMATE_CONFIG/);
  assert.match(source('shared/config-store.cjs'), /SUPPORTED_CONFIG_VERSION/);
});

test('one work-session model is shared across local and member workflows', () => {
  const collaboration = source('gateway/team-collaboration-tools.mjs');
  const shared = source('gateway/local-shared.mjs');
  assert.match(collaboration, /work_session_start/);
  assert.match(collaboration, /work_session_status/);
  assert.match(collaboration, /work_session_finish/);
  assert.match(collaboration, /work_session_rollback/);
  assert.match(shared, /workSessionId/);
});

test('desktop public connection lifecycle is provider-native and shared', () => {
  const controller = source('vscode-host/tunnel-controller.js');
  const runtime = source('vscode-host/tunnel-runtime.js');
  const obsidian = source('obsidian-plugin/src/main.js');
  assert.match(controller, /class TunnelController/);
  assert.match(runtime, /tunnelController\(\)\.start\(port\)/);
  assert.match(obsidian, /new TunnelController/);
  assert.match(obsidian, /this\.tunnelController\.start\(gateway\.port\)/);
});
