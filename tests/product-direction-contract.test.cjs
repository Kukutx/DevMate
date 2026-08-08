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
  assert.match(entry, /validateTunnelProvider/);
  assert.match(entry, /new TunnelController/);
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
