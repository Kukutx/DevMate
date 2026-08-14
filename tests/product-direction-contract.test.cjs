'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const json = relative => JSON.parse(source(relative));

test('fresh shared instance owns the ngrok connection default while retaining all current providers', () => {
  const store = require('../shared/config-store.cjs');
  const schema = require('../shared/instance-config.cjs');
  const config = store.newInstanceConfig({ workspaceRoot: root });
  assert.deepEqual(config.connection, { provider: 'ngrok', publicUrl: '' });
  assert.deepEqual(schema.CONNECTION_PROVIDERS, ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
});

test('shared instance connection is authoritative for provider and stable public URL', () => {
  const effective = source('vscode-host/effective-tunnel-settings.js');
  assert.match(effective, /const connection = sharedConnection\(sharedConfig\)/);
  assert.match(effective, /normalized\.connection\.provider/);
  assert.match(effective, /normalized\.connection\.publicUrl/);
  assert.match(effective, /provider === 'ngrok' \? stablePublicUrl : ''/);
  assert.match(effective, /DEVMATE_SHARED_CONFIG_MISSING/);
});

test('VS Code manifest keeps lifecycle preferences and provider execution settings', () => {
  const properties = json('package.json').contributes.configuration.properties;
  for (const key of [
    'devMate.autoStart',
    'devMate.ngrokUrl',
    'devMate.publicUrl',
    'devMate.ngrokCommandPath',
    'devMate.cloudflareCommandPath'
  ]) assert.equal(Object.hasOwn(properties, key), true);
});

test('Connection Setup commits the shared connection capability transactionally', () => {
  const platform = source('extension-entry-platform.js');
  const start = platform.indexOf('async function configureConnection');
  const end = platform.indexOf('async function connectionDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const sharedPatch = \{\s*provider: providerChoice\.value,\s*publicUrl\s*\}/s);
  assert.match(block, /await commitConnectionSettings\(context, localUpdates, sharedPatch\)/);
});

test('provider-specific endpoint selection is derived from shared connection state', () => {
  const effective = source('vscode-host/effective-tunnel-settings.js');
  assert.match(effective, /provider === 'cloudflare-managed' \|\| provider === 'external' \? stablePublicUrl : ''/);
  assert.match(effective, /provider === 'ngrok' \? stablePublicUrl : ''/);
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

test('normal Obsidian UI presents Ready as one product state', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /action\('Start'/);
  assert.match(view, /moreAction\('Stop'/);
  assert.match(view, /action\('Restart'/);
  assert.match(view, /action\('Copy MCP URL'/);
});

test('shared provider ownership identity includes current provider execution details', () => {
  const runtime = source('vscode-host/tunnel-runtime.js');
  const store = source('vscode-host/shared-tunnel-record-store.js');
  assert.match(runtime, /const current = tunnelController\(\)/);
  assert.match(runtime, /(?:const result = await|return await) current\.start\(port\)/);
  assert.match(runtime, /attachmentRecoveryPromise/);
  assert.match(runtime, /if \(pendingRecovery\) await pendingRecovery\.catch\(\(\) => null\)/);
  assert.match(runtime, /return current\.stop\(\)/);
  assert.match(store, /ngrokCommandPath/);
  assert.match(store, /ngrokUseManagedAccount/);
  assert.match(store, /cloudflareCommandPath/);
});

test('provider-native runtime and documentation describe one shared connection implementation', () => {
  const controller = require('../vscode-host/tunnel-controller.js');
  const docs = source('docs/TUNNELS.md');
  assert.equal(typeof controller.TunnelController, 'function');
  assert.match(docs, /one shared public connection capability/i);
  assert.match(docs, /complete desktop session generation/i);
});
