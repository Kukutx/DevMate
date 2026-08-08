'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(source(relative));
const REMOVED_GLOBAL_BUSINESS_SETTINGS = [
  'devMate.tunnelProvider',
  'devMate.deploymentMode',
  'devMate.teamRequireWorkspaceLeaseForWrites',
  'devMate.productionMaxRequestBytes',
  'devMate.productionRequestsPerMinute',
  'devMate.productionMaxConcurrentRequests',
  'devMate.productionMaxConcurrentPerPrincipal',
  'devMate.productionRequestTimeoutMs',
  'devMate.allowedPublicHosts',
  'devMate.vscodeHostEnabled'
];

test('fresh shared instance owns the ngrok connection default while retaining all current providers', () => {
  const sharedConfig = source('shared/config-store.cjs');
  const settings = source('vscode-host/tunnel-settings.js');
  const entry = source('extension-entry-shared-tunnel.js');
  assert.match(sharedConfig, /connection: \{ provider: 'ngrok', publicUrl: '' \}/);
  assert.match(settings, /\['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external'\]/);
  assert.match(entry, /settingsFromState/);
  assert.match(entry, /new TunnelController/);
  assert.doesNotMatch(entry, /setting\(vscode, 'tunnelProvider'/);
  assert.doesNotMatch(entry, /setting\(vscode, 'deploymentMode'/);
  assert.equal(fs.existsSync(path.join(root, 'vscode-host/shared-deployment-config.js')), false);
});

test('shared workspace connection is authoritative for provider and stable public URL', () => {
  const entry = source('extension-entry-shared-tunnel.js');
  const effective = source('vscode-host/effective-tunnel-settings.js');
  assert.match(entry, /settings: \(\) => tunnelSettings\(runtimeStateDirectory\)/);
  assert.match(effective, /sharedConnection\(sharedConfig\)/);
  assert.match(effective, /normalized\.connection\.provider/);
  assert.match(effective, /normalized\.connection\.publicUrl/);
  assert.match(effective, /provider === 'ngrok' \? fallbackNgrokUrl/);
  assert.doesNotMatch(effective, /deploymentMode|sharedDeployment|deployment\?\./);
});

test('VS Code manifest exposes one auto-start preference and no machine-global business mode controls', () => {
  const properties = json('package.json').contributes.configuration.properties;
  for (const key of REMOVED_GLOBAL_BUSINESS_SETTINGS) {
    assert.equal(Object.hasOwn(properties, key), false, `${key} must not be a Global Setting`);
  }
  assert.equal(Object.hasOwn(properties, 'devMate.autoStart'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.ngrokUrl'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.publicUrl'), true);
});

test('Connection Setup writes only connection capability to the current shared instance', () => {
  const platform = source('extension-entry-platform.js');
  const start = platform.indexOf('async function configureConnection');
  const end = platform.indexOf('async function connectionDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const sharedPatch = \{\s*provider: providerChoice\.value,\s*publicUrl\s*\}/s);
  assert.match(block, /await commitConnectionSettings\(context, localUpdates, sharedPatch\)/);
  assert.doesNotMatch(block, /modeChoice|deploymentMode|productionMax|teamRequireWorkspaceLease/);
});

test('platform has no Global Settings to shared instance business synchronization path', () => {
  const platform = source('extension-entry-platform.js');
  assert.doesNotMatch(platform, /settingPatch/);
  assert.doesNotMatch(platform, /settingRollback/);
  assert.doesNotMatch(platform, /syncExplicitSettingChange/);
  assert.doesNotMatch(platform, /onDidChangeConfiguration/);
});

test('stable URL candidates remain provider-specific without becoming a second business-state source', () => {
  const helper = source('vscode-host/deployment-public-url.js');
  const platform = source('extension-entry-platform.js');
  assert.match(helper, /provider === 'ngrok'/);
  assert.match(helper, /settings\.ngrokUrl/);
  assert.match(helper, /provider === 'cloudflare-managed' \|\| provider === 'external'/);
  assert.match(helper, /provider === 'cloudflare-quick'\) return ''/);
  assert.match(platform, /localUpdates\.ngrokUrl = url/);
  assert.match(platform, /localUpdates\.publicUrl = url/);
  assert.match(platform, /sharedPatch =/);
});

test('Obsidian is a first-class owner or attacher of the same provider-native shared connection', () => {
  const main = source('obsidian-plugin/src/main.js');
  const settings = source('obsidian-plugin/src/settings.js');
  assert.match(main, /new RuntimeController/);
  assert.match(main, /new ObsidianHostBridge/);
  assert.match(main, /new TunnelController/);
  assert.match(main, /this\.tunnelController\.start\(gateway\.port\)/);
  assert.match(main, /verifyPublicEndpoint\(publicUrl, tunnel\.record\)/);
  assert.match(settings, /Connection provider/);
  assert.match(settings, /ngrokAuthtokenEncrypted/);
  assert.match(settings, /cloudflareTunnelTokenEncrypted/);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/public-connection.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/ngrok-runtime.js')), false);
});

test('normal Obsidian UI presents Ready as one product state instead of transport architecture', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /action\('Start'/);
  assert.match(view, /action\('Stop'/);
  assert.match(view, /action\('Restart'/);
  assert.match(view, /action\('Copy MCP URL'/);
  assert.doesNotMatch(view, /Public ingress|Internal Gateway|Verification|internal only/);
});

test('shared provider ownership remains strict instead of silently merging different configurations', () => {
  const runtime = source('vscode-host/tunnel-runtime.js');
  const store = source('vscode-host/shared-tunnel-record-store.js');
  assert.doesNotMatch(runtime, /sharedReadyAttachment|runtimeStatus/);
  assert.match(runtime, /const result = await tunnelController\(\)\.start\(port\)/);
  assert.match(store, /ngrokCommandPath/);
  assert.match(store, /ngrokUseManagedAccount/);
  assert.match(store, /cloudflareCommandPath/);
});

test('provider-native runtime remains current-only without the retired virtual ngrok compatibility API', () => {
  const provider = source('tunnel-provider.js');
  const docs = source('docs/TUNNELS.md');
  assert.doesNotMatch(provider, /TunnelCompatibilityManager|virtualHttpRequest|virtualChild|requestTarget/);
  assert.doesNotMatch(docs, /virtual ngrok-compatible local API/i);
  assert.match(docs, /Provider selection is a \*\*connection capability\*\*, not a runtime mode and not a compatibility shim/i);
});
