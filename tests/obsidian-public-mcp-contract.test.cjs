'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Obsidian Start manages the shared Gateway only and never owns public ingress', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async startRuntimeInternal');
  const end = main.indexOf('stopRuntime()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /const result = await this\.controller\.start\(\)/);
  assert.doesNotMatch(block, /TunnelController|ngrokRuntime|startTunnel|cloudflared|NGROK_AUTHTOKEN/);
  assert.doesNotMatch(main, /deployment\.tunnelProvider\s*=|deployment\.publicUrl\s*=/);
  assert.doesNotMatch(main, /ObsidianNgrokRuntime|ngrokDoctor|ngrok-runtime|secret-store/);
});

test('Obsidian resolves public ingress read-only and verifies before Copy MCP URL', () => {
  const main = source('obsidian-plugin/src/main.js');
  const resolver = source('obsidian-plugin/src/public-connection.js');
  const start = main.indexOf('async copyConnectionUrl()');
  const end = main.indexOf('async copyConnectionToken()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /const connection = this\.publicConnection\(gateway\.port\)/);
  assert.match(block, /await this\.verifyPublicEndpoint\(connection\.publicOrigin\)/);
  assert.match(block, /writeText\(test\.mcpUrl\)/);
  assert.doesNotMatch(block, /127\.0\.0\.1|ownerUrl\(/);
  assert.match(resolver, /SharedTunnelRecordStore/);
  assert.match(resolver, /source: 'shared-tunnel'/);
  assert.match(resolver, /source: 'obsidian-setting'/);
  assert.match(resolver, /source: 'deployment-config'/);
  assert.doesNotMatch(resolver, /\.start\(|\.stop\(|TunnelController/);
});

test('Obsidian settings expose an external public origin but no tunnel-provider ownership settings', () => {
  const settings = source('obsidian-plugin/src/settings.js');
  const build = source('obsidian-plugin/esbuild.config.mjs');
  assert.match(settings, /publicOrigin: ''/);
  assert.match(settings, /setName\('Public origin'\)/);
  assert.doesNotMatch(settings, /ngrokCommandPath|ngrokAuthtokenEncrypted|ngrokPoolingEnabled|tunnelAutoRestart|autoCopyUrl/);
  assert.match(build, /target: 'node24'/);
  assert.doesNotMatch(build, /target: 'node18'/);
});

test('Obsidian UI keeps Gateway and public ingress as separate concepts', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /connectionDetail\('Public MCP'\)/);
  assert.match(view, /connectionDetail\('Public ingress'\)/);
  assert.match(view, /connectionDetail\('Internal Gateway'\)/);
  assert.match(view, /internal only/);
  assert.doesNotMatch(view, /connectionDetail\('ngrok'\)/);
  assert.doesNotMatch(view, /ngrok Doctor/);
});
