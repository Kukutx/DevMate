'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const ngrokSetupEntry = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');
const tunnelEntry = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
const tunnelController = fs.readFileSync(path.join(root, 'vscode-host', 'tunnel-controller.js'), 'utf8');

test('actual VS Code Start and Stop use the shared RuntimeController', () => {
  assert.match(source, /const \{ RuntimeController \} = require\('\.\/host\/runtime-controller\.js'\)/);
  assert.doesNotMatch(source, /SUPPORTED_CONFIG_VERSION/);
  assert.match(source, /gatewayController = new RuntimeController\(/);
  assert.match(source, /const result = await controller\.start\(\{timeoutMs:20000\}\)/);
  assert.match(source, /const result = await gatewayController\.stop\(\)/);
  assert.match(source, /await gatewayController\?\.dispose\(\{stopOwned:tunnelAllowsGatewayShutdown\(stopped\?\.tunnel\)\}\)/);
  assert.doesNotMatch(source, /function spawnNode\(/);
  assert.doesNotMatch(source, /gatewayProcess\s*=\s*spawnNode\(/);
});

test('VS Code Stop preserves the Gateway while public connection ownership is remote or shutdown is unconfirmed', () => {
  const start = source.indexOf('async function stopAll()');
  const end = source.indexOf('async function copyUrl()', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const safetyGate = block.indexOf('if(!tunnelAllowsGatewayShutdown(tunnel))');
  const gatewayStop = block.indexOf('gateway = await stopGatewayProcess()');
  assert.ok(safetyGate >= 0 && gatewayStop > safetyGate);
  assert.match(block, /tunnelState\.remoteOwner[\s\S]*preserved-for-remote-public-connection/);
  assert.match(block, /return \{ok:false,sharedStillActive:true,gateway:\{stopped:false,reason\},tunnel,startCommand\}/);
});

test('failed Start preserves a newly owned Gateway while a pre-existing or attached public connection still depends on it', () => {
  const start = source.indexOf('async function rollbackFailedStart');
  const end = source.indexOf('async function quickStart', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /let publicConnectionSafeToReleaseGateway = !tunnelWasRunning && !\(tunnel\?\.attached && !tunnel\?\.owned\)/);
  assert.match(block, /publicConnectionSafeToReleaseGateway = tunnelAllowsGatewayShutdown\(stopped\)/);
  assert.match(block, /gateway\?\.started && gateway\?\.owned && publicConnectionSafeToReleaseGateway/);
  assert.match(block, /Preserving the newly owned Gateway because public connection shutdown was not confirmed/);
  assert.doesNotMatch(block, /sharedTunnelActive/);
});

test('actual VS Code process calls use native child_process and the shared runtime network', () => {
  assert.match(source, /const \{ spawn, spawnSync \} = require\('node:child_process'\)/);
  assert.match(source, /const \{ healthAt, healthMatches \} = require\('\.\/host\/runtime\/network\.js'\)/);
  assert.match(source, /resolveNodeRuntime/);
  assert.doesNotMatch(source, /runtime-io\.js|bounded-http-client\.js|SpawnLayer/);
  assert.doesNotMatch(source, /ms-enable-electron-run-as-node/);
  assert.doesNotMatch(source, /version:\s*9\b/);
  assert.doesNotMatch(source, /data\.version\s*=\s*9\b/);
});

test('ngrok setup owns only configuration and secrets while TunnelController owns provider processes', () => {
  assert.doesNotMatch(ngrokSetupEntry, /SpawnLayer|runtime-io\.js|createExtensionSpawn|installManagedSpawnLayer/);
  assert.match(ngrokSetupEntry, /context\.secrets\.store\(SECRET_KEY, validateAuthtoken\(token\)\)/);
  assert.match(ngrokSetupEntry, /managedAuthtoken = validateAuthtoken\(token\)/);
  assert.match(ngrokSetupEntry, /writeActiveNgrokUrl/);
  assert.doesNotMatch(ngrokSetupEntry, /childProcess\.spawn\(/);
  assert.match(ngrokSetupEntry, /activationAttempted/);
  assert.match(ngrokSetupEntry, /activated/);

  assert.match(tunnelEntry, /new TunnelController\(/);
  assert.match(tunnelEntry, /setTunnelController\(runtime\)/);
  assert.match(tunnelEntry, /getSecrets: \(\) => tunnelSecrets\(context\)/);
  assert.match(tunnelController, /this\.childProcess\.spawn\(launch\.command, launch\.args, launch\.options\)/);
  assert.doesNotMatch(tunnelController, /TunnelCompatibilityManager|virtualHttpRequest|virtualChild/);
});

test('auxiliary process and tunnel ownership cannot clear newer handles', () => {
  assert.match(source, /if\(startCommandProcess === child\) startCommandProcess=null/);
  assert.match(source, /if\(gatewayProcess !== child\) return/);
  assert.doesNotMatch(source, /ngrokProcess/);

  assert.match(tunnelController, /if \(this\.child !== child\) return/);
  assert.match(tunnelController, /if \(ownerId && this\.ownerId !== ownerId\) return false/);
  assert.match(tunnelController, /this\.clearLocalOwnership\(ownerId\)/);
  assert.match(tunnelController, /record\.ownerId !== this\.ownerId/);
});

test('Gateway process termination has one runtime log owner while the VS Code observer only refreshes UI', () => {
  const start = source.indexOf('function trackGatewayProcess(child)');
  const end = source.indexOf('async function stopGatewayProcess()', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /Gateway exited code=/);
  assert.match(block, /setStatus\('DevMate: stopped'\)/);
  assert.match(block, /refreshPanel\(\)/);
});
