'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('desktop hosts use the shared child-process Gateway controller', () => {
  const processController = source('host/runtime/process-controller.js');
  const vscode = source('extension.js');
  const obsidian = source('obsidian-plugin/src/main.js');
  assert.match(processController, /class RuntimeController/);
  assert.match(processController, /spawnImpl = spawn/);
  assert.match(vscode, /new RuntimeController\(\{/);
  assert.match(obsidian, /new RuntimeController\(\{/);
  assert.match(obsidian, /resolveNodeRuntime/);
});

test('packaged Obsidian provider supervision is rooted in the installed plugin directory', () => {
  const obsidian = source('obsidian-plugin/src/main.js');
  const createStart = obsidian.indexOf('createProviderChildProcess(pluginDirectory, nodeExecutable)');
  const createEnd = obsidian.indexOf('createTunnelController(pluginDirectory, stateDirectory)', createStart);
  const createBlock = obsidian.slice(createStart, createEnd);
  const tunnelStart = createEnd;
  const tunnelEnd = obsidian.indexOf('\n  tunnelSecrets() {', tunnelStart);
  const tunnelBlock = obsidian.slice(tunnelStart, tunnelEnd);

  assert.ok(createStart >= 0 && createEnd > createStart);
  assert.match(obsidian, /createSupervisedChildProcess/);
  assert.match(createBlock, /nodeExecutable/);
  assert.match(createBlock, /supervisorEntry: path\.join\(pluginDirectory, 'provider-supervisor\.cjs'\)/);
  assert.match(tunnelBlock, /const nodeRuntime = this\.ensureNodeRuntime\(\)/);
  assert.match(tunnelBlock, /const childProcess = this\.createProviderChildProcess\(pluginDirectory, nodeRuntime\.executable\)/);
  assert.match(tunnelBlock, /new DesktopTunnelController\(\{[\s\S]*childProcess/);
});

test('Gateway uses the current DEVMATE_CONFIG instance contract', () => {
  const store = require('../shared/config-store.cjs');
  assert.match(source('gateway/local-shared.mjs'), /DEVMATE_CONFIG/);
  assert.match(source('gateway/server.mjs'), /DEVMATE_CONFIG/);
  assert.equal(typeof store.newInstanceConfig, 'function');
  assert.equal(typeof store.ensureInstanceConfig, 'function');
  assert.equal(Number.isInteger(store.SUPPORTED_CONFIG_VERSION), true);
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
  const providerController = source('vscode-host/tunnel-controller.js');
  const desktopController = source('vscode-host/desktop-tunnel-controller.js');
  const runtime = source('vscode-host/tunnel-runtime.js');
  const vscodeTunnel = source('extension-entry-shared-tunnel.js');
  const obsidian = source('obsidian-plugin/src/main.js');

  assert.match(providerController, /class TunnelController/);
  assert.match(desktopController, /class DesktopTunnelController extends TunnelController/);
  assert.match(desktopController, /withConnectionMutationLease/);
  assert.match(desktopController, /readLifecycleIntent/);

  assert.match(runtime, /const current = tunnelController\(\)/);
  assert.match(runtime, /await current\.start\(port\)/);
  assert.match(runtime, /attachmentRecoveryPromise/);
  assert.match(runtime, /if \(pendingRecovery\) await pendingRecovery\.catch\(\(\) => null\)/);
  assert.match(runtime, /return current\.stop\(\)/);

  assert.match(vscodeTunnel, /new DesktopTunnelController\(\{/);
  assert.match(obsidian, /new DesktopTunnelController\(\{/);
  assert.match(obsidian, /this\.tunnelController\.start\(gateway\.port\)/);
});

test('ngrok discovery is pinned to the current v3 Agent endpoints API and exact response shape', () => {
  const agent = source('vscode-host/ngrok-agent-api.js');
  const support = source('ngrok-support.js');
  const controller = source('vscode-host/tunnel-controller.js');
  assert.match(agent, /\/endpoints/);
  assert.match(agent, /item\?\.url/);
  assert.match(agent, /item\?\.upstream\?\.url/);
  for (const retired of ['tun' + 'nels', 'public' + '_url', 'upstream' + '_url', 'forwards' + '_to', 'config' + '.addr']) {
    assert.equal(agent.includes(retired), false, `retired ngrok Agent API shape must not return: ${retired}`);
  }
  assert.match(support, /supportsNgrokEndpointsApi/);
  assert.match(controller, /requires ngrok 3\.30\.0\+ for current Agent API endpoint discovery/);
});
