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
  assert.match(source, /const \{ RuntimeController, SUPPORTED_CONFIG_VERSION \} = require\('\.\/host\/runtime-controller\.js'\)/);
  assert.match(source, /gatewayController = new RuntimeController\(/);
  assert.match(source, /const result = await controller\.start\(\{timeoutMs:20000\}\)/);
  assert.match(source, /const result = await gatewayController\.stop\(\)/);
  assert.match(source, /await gatewayController\?\.dispose\(\{stopOwned:true\}\)/);
  assert.doesNotMatch(source, /function spawnNode\(/);
  assert.doesNotMatch(source, /gatewayProcess\s*=\s*spawnNode\(/);
});

test('safe VS Code Stop releases locally owned Gateway even when provider ownership is remote', () => {
  const start = source.indexOf('async function stopAll()');
  const end = source.indexOf('async function copyUrl()', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  const unsafeReturn = block.indexOf('if(!tunnelState.safe)');
  const gatewayStop = block.indexOf('gateway = await stopGatewayProcess()');
  assert.ok(unsafeReturn >= 0 && gatewayStop > unsafeReturn);
  assert.doesNotMatch(block, /preserved-for-shared-connection/);
  assert.match(block, /const sharedStillActive = tunnelState\.remoteOwner \|\| gateway\.reason === 'managed-by-another-host' \|\| gateway\.attached === true/);
});

test('failed Start preserves a newly owned Gateway only when public connection shutdown is unconfirmed', () => {
  const start = source.indexOf('async function rollbackFailedStart');
  const end = source.indexOf('async function quickStart', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /publicConnectionSafeToReleaseGateway = classifyTunnelStop\(stopped\)\.safe/);
  assert.match(block, /gateway\?\.started && gateway\?\.owned && publicConnectionSafeToReleaseGateway/);
  assert.match(block, /Preserving the newly owned Gateway because public connection shutdown was not confirmed/);
  assert.doesNotMatch(block, /sharedTunnelActive/);
});

test('actual VS Code process calls resolve the private active spawn chain at call time', () => {
  assert.match(source, /const childProcess = require\('\.\/vscode-host\/runtime-io\.js'\)/);
  assert.match(source, /function spawn\(\.\.\.args\)\{ return childProcess\.spawn\(\.\.\.args\); \}/);
  assert.match(source, /function spawnSync\(\.\.\.args\)\{ return childProcess\.spawnSync\(\.\.\.args\); \}/);
  assert.doesNotMatch(source, /const childProcess = require\('child_process'\)/);
  assert.doesNotMatch(source, /const \{ spawn, spawnSync \} = require\('child_process'\)/);
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
