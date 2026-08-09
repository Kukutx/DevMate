'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(source(relative));

test('fresh shared instance owns the ngrok connection default while retaining all current providers', () => {
  const sharedConfig = source('shared/config-store.cjs');
  const settings = source('vscode-host/tunnel-settings.js');
  const entry = source('extension-entry-shared-tunnel.js');
  assert.match(sharedConfig, /connection: \{ provider: 'ngrok', publicUrl: '' \}/);
  assert.match(settings, /\['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external'\]/);
  assert.match(entry, /settingsFromState/);
  assert.match(entry, /new TunnelController/);
});

test('shared instance connection is authoritative for provider and stable public URL', () => {
  const entry = source('extension-entry-shared-tunnel.js');
  const effective = source('vscode-host/effective-tunnel-settings.js');
  assert.match(entry, /settings: \(\) => tunnelSettings\(runtimeStateDirectory\)/);
  assert.match(effective, /sharedConnection\(sharedConfig\)/);
  assert.match(effective, /normalized\.connection\.provider/);
  assert.match(effective, /normalized\.connection\.publicUrl/);
  assert.match(effective, /provider === 'ngrok' \? fallbackNgrokUrl/);
  assert.doesNotMatch(effective, /deploymentMode|sharedDeployment|config\.deployment/);
});

test('VS Code manifest keeps lifecycle preference and machine-local provider execution settings only', () => {
  const properties = json('package.json').contributes.configuration.properties;
  assert.equal(Object.hasOwn(properties, 'devMate.autoStart'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.ngrokUrl'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.publicUrl'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.ngrokCommandPath'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.cloudflareCommandPath'), true);
  assert.equal(Object.hasOwn(properties, 'devMate.deploymentMode'), false);
  assert.equal(Object.hasOwn(properties, 'devMate.tunnelProvider'), false);
});

test('Connection Setup writes only the shared connection capability', () => {
  const platform = source('extension-entry-platform.js');
  const start = platform.indexOf('async function configureConnection');
  const end = platform.indexOf('async function connectionDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const sharedPatch = \{\s*provider: providerChoice\.value,\s*publicUrl\s*\}/s);
  assert.match(block, /await commitConnectionSettings\(context, localUpdates, sharedPatch\)/);
  assert.doesNotMatch(block, /modeChoice|deploymentMode/);
});

test('provider-specific endpoint candidates are resolved only inside effective tunnel settings', () => {
  const effective = source('vscode-host/effective-tunnel-settings.js');
  assert.match(effective, /provider === 'cloudflare-managed' \|\| provider === 'external' \? stablePublicUrl : ''/);
  assert.match(effective, /provider === 'ngrok' \? fallbackNgrokUrl : ''/);
  assert.equal(fs.existsSync(path.join(root, 'vscode-host', 'deployment-public-url.js')), false);
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
});

test('normal Obsidian UI presents Ready as one product state instead of transport architecture', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /action\('Start'/);
  assert.match(view, /action\('Stop'/);
  assert.match(view, /action\('Restart'/);
  assert.match(view, /action\('Copy MCP URL'/);
  assert.doesNotMatch(view, /Public ingress|Internal Gateway|internal only/);
});

test('shared provider ownership remains strict instead of silently merging different configurations', () => {
  const runtime = source('vscode-host/tunnel-runtime.js');
  const store = source('vscode-host/shared-tunnel-record-store.js');
  assert.match(runtime, /const result = await tunnelController\(\)\.start\(port\)/);
  assert.match(store, /ngrokCommandPath/);
  assert.match(store, /ngrokUseManagedAccount/);
  assert.match(store, /cloudflareCommandPath/);
});

test('provider-native runtime is the only desktop public connection implementation', () => {
  const provider = source('tunnel-provider.js');
  const docs = source('docs/TUNNELS.md');
  assert.match(source('vscode-host/tunnel-controller.js'), /class TunnelController/);
  assert.doesNotMatch(provider, /TunnelCompatibilityManager|virtualHttpRequest|virtualChild|requestTarget/);
  assert.match(docs, /Provider selection is a \*\*connection capability\*\*, not a runtime mode and not a compatibility shim/i);
});
