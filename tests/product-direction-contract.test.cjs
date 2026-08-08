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
  'devMate.allowedPublicHosts'
];

test('shared personal config owns the ngrok default while retaining all current deployment providers', () => {
  const sharedConfig = source('shared/config-store.cjs');
  const settings = source('vscode-host/tunnel-settings.js');
  const entry = source('extension-entry-shared-tunnel.js');
  const editor = source('vscode-host/shared-deployment-config.js');
  assert.match(sharedConfig, /deployment: \{ mode: 'personal', tunnelProvider: 'ngrok', publicUrl: '' \}/);
  assert.match(settings, /\['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external'\]/);
  assert.match(entry, /settingsFromState/);
  assert.match(entry, /new TunnelController/);
  assert.doesNotMatch(entry, /setting\(vscode, 'tunnelProvider'/);
  assert.doesNotMatch(entry, /setting\(vscode, 'deploymentMode'/);
  assert.doesNotMatch(entry, /normalizeBootstrapDeployment/);
  assert.doesNotMatch(editor, /normalizeBootstrapDeployment/);
});

test('shared workspace config is authoritative for tunnel mode, provider, and stable public URL', () => {
  const entry = source('extension-entry-shared-tunnel.js');
  const effective = source('vscode-host/effective-tunnel-settings.js');
  assert.match(entry, /settings: \(\) => tunnelSettings\(runtimeStateDirectory\)/);
  assert.match(effective, /sharedDeployment\(sharedConfig\)/);
  assert.match(effective, /deployment\?\.provider \|\|/);
  assert.match(effective, /deployment\?\.mode \|\|/);
  assert.match(effective, /provider === 'ngrok' \? fallbackNgrokUrl/);
});

test('VS Code manifest does not expose machine-global deployment business controls', () => {
  const properties = json('package.json').contributes.configuration.properties;
  for (const key of REMOVED_GLOBAL_BUSINESS_SETTINGS) {
    assert.equal(Object.hasOwn(properties, key), false, `${key} must stay workspace-scoped in shared config`);
  }
  assert.equal(Object.hasOwn(properties, 'devMate.ngrokUrl'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.publicUrl'), true);
});

test('generic VS Code context writes cannot overwrite shared deployment, team, production, or active server state', () => {
  const sync = source('vscode-host/config-sync.js');
  assert.match(sync, /'deployment', 'team', 'production'/);
  assert.match(sync, /if \(has\(current, 'server'\)\) merged\.server = current\.server/);
  assert.doesNotMatch(sync, /'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'/);
});

test('deployment setup writes business state directly to the current shared config', () => {
  const platform = source('extension-entry-platform.js');
  const start = platform.indexOf('async function configureDeployment');
  const end = platform.indexOf('async function tunnelDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const localUpdates = \{\}/);
  assert.match(block, /const sharedPatch =/);
  assert.match(block, /mode: modeChoice\.value/);
  assert.match(block, /tunnelProvider: providerChoice\.value/);
  assert.match(block, /await commitDeploymentSettings\(context, localUpdates, sharedPatch\)/);
  assert.doesNotMatch(block, /localUpdates\.deploymentMode/);
  assert.doesNotMatch(block, /localUpdates\.tunnelProvider/);
});

test('platform has no Global Settings to shared deployment synchronization path', () => {
  const platform = source('extension-entry-platform.js');
  assert.doesNotMatch(platform, /settingPatch/);
  assert.doesNotMatch(platform, /settingRollback/);
  assert.doesNotMatch(platform, /syncExplicitSettingChange/);
  assert.doesNotMatch(platform, /onDidChangeConfiguration/);
});

test('stable deployment URL candidates remain provider-specific without becoming active business state', () => {
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

test('Obsidian remains a shared Gateway host and never becomes a tunnel-provider owner', () => {
  const main = source('obsidian-plugin/src/main.js');
  const settings = source('obsidian-plugin/src/settings.js');
  assert.match(main, /new RuntimeController/);
  assert.match(main, /new ObsidianHostBridge/);
  assert.match(main, /resolvePublicConnection/);
  assert.doesNotMatch(main, /new TunnelController|ObsidianNgrokRuntime|ngrokRuntime|NGROK_AUTHTOKEN/);
  assert.doesNotMatch(main, /deployment\.tunnelProvider\s*=|deployment\.publicUrl\s*=/);
  assert.match(settings, /publicOrigin/);
  assert.doesNotMatch(settings, /ngrokCommandPath|ngrokAuthtokenEncrypted|cloudflareCommandPath|tunnelProvider/);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/ngrok-runtime.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/secret-store.js')), false);
});

test('Obsidian public connection discovery is passive and provider-neutral', () => {
  const resolver = source('obsidian-plugin/src/public-connection.js');
  assert.match(resolver, /SharedTunnelRecordStore/);
  assert.match(resolver, /record\.provider/);
  assert.match(resolver, /deployment\?\.tunnelProvider/);
  assert.doesNotMatch(resolver, /TunnelController|startTunnel|stopTunnel|\.start\(|\.stop\(/);
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
  assert.match(docs, /Provider selection is a deployment feature, not a compatibility shim/i);
});