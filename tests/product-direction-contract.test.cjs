'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(source(relative));

test('VS Code keeps ngrok as default while retaining all current deployment providers', () => {
  const pkg = json('package.json');
  const provider = pkg.contributes.configuration.properties['devMate.tunnelProvider'];
  assert.equal(provider.default, 'ngrok');
  assert.deepEqual(provider.enum, ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);

  const entry = source('extension-entry-shared-tunnel.js');
  assert.match(entry, /setting\(vscode, 'tunnelProvider', 'ngrok'\)/);
  assert.match(entry, /settingsFromState/);
  assert.match(entry, /new TunnelController/);
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

test('generic VS Code context writes cannot overwrite shared deployment, team, production, or active server state', () => {
  const sync = source('vscode-host/config-sync.js');
  assert.match(sync, /'deployment', 'team', 'production'/);
  assert.match(sync, /if \(has\(current, 'server'\)\) merged\.server = current\.server/);
  assert.doesNotMatch(sync, /'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'/);
});

test('deployment setup commits shared business state only after required provider input is complete', () => {
  const platform = source('extension-entry-platform.js');
  const start = platform.indexOf('async function configureDeployment');
  const end = platform.indexOf('function settingPatch', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const localUpdates =/);
  assert.match(block, /const sharedPatch =/);
  assert.match(block, /await commitDeploymentSettings\(context, localUpdates, sharedPatch\)/);
  assert.doesNotMatch(block, /await updateSetting\('deploymentMode'/);
  assert.doesNotMatch(block, /await updateSetting\('tunnelProvider'/);
});

test('activation and Doctor never perform a whole deployment synchronization from machine settings', () => {
  const platform = source('extension-entry-platform.js');
  assert.doesNotMatch(platform, /function syncDeploymentConfig/);
  assert.doesNotMatch(platform, /syncDeploymentConfig\(context\)/);
  assert.match(platform, /syncExplicitSettingChange/);
  assert.match(platform, /settingPatch/);
});

test('stable deployment URL is selected by provider instead of leaking between providers', () => {
  const helper = source('vscode-host/deployment-public-url.js');
  const platform = source('extension-entry-platform.js');
  assert.match(helper, /provider === 'ngrok'/);
  assert.match(helper, /settings\.ngrokUrl/);
  assert.match(helper, /provider === 'cloudflare-managed' \|\| provider === 'external'/);
  assert.match(helper, /provider === 'cloudflare-quick'\) return ''/);
  assert.match(platform, /stablePublicUrl/);
  assert.match(platform, /patch\.publicUrl = stablePublicUrl/);
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
