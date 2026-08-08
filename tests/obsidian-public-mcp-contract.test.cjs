'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Obsidian Start owns the same complete Gateway to verified Ready lifecycle as VS Code', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async startRuntimeInternal');
  const end = main.indexOf('stopRuntime()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /gateway = await this\.controller\.start\(\)/);
  assert.match(block, /tunnel = await this\.tunnelController\.start\(gateway\.port\)/);
  assert.match(block, /const preflight = await this\.verifyPublicEndpoint\(publicUrl\)/);
  assert.match(block, /state: 'ready'/);
  assert.match(block, /mcpUrl: preflight\.mcpUrl/);
  assert.match(block, /toolCount: preflight\.toolCount/);
  assert.match(block, /if \(tunnel\?\.owned\)[\s\S]*this\.tunnelController\.stop\(\)/);
  assert.match(block, /if \(gateway\?\.started && gateway\?\.owned\)[\s\S]*this\.controller\.stop\(\)/);
});

test('Obsidian Copy MCP URL verifies the active public endpoint before copying it', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async copyConnectionUrl()');
  const end = main.indexOf('async copyConnectionToken()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /await this\.verifyPublicEndpoint/);
  assert.match(block, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(block, /127\.0\.0\.1|ownerUrl\(/);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/public-connection.js')), false);
});

test('Obsidian uses provider-native shared connection ownership with secure optional credentials', () => {
  const main = source('obsidian-plugin/src/main.js');
  const settings = source('obsidian-plugin/src/settings.js');
  const build = source('obsidian-plugin/esbuild.config.mjs');
  assert.match(main, /TunnelController/);
  assert.match(settings, /Connection provider/);
  assert.match(settings, /ngrokAuthtokenEncrypted/);
  assert.match(settings, /cloudflareTunnelTokenEncrypted/);
  assert.match(settings, /OS-backed Electron safe storage API/);
  assert.doesNotMatch(settings, /publicOrigin/);
  assert.match(build, /target: 'node24'/);
  assert.doesNotMatch(build, /target: 'node18'/);
});

test('Obsidian normal panel exposes one user-facing Ready state, not internal transport layers', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /action\('Start'/);
  assert.match(view, /action\('Stop'/);
  assert.match(view, /action\('Restart'/);
  assert.match(view, /action\('Copy MCP URL'/);
  assert.doesNotMatch(view, /Public MCP|Public connection|Public ingress|Internal Gateway|Verification|internal only/);
  assert.doesNotMatch(view, /Copy Bearer Token/);
  assert.match(view, /setText\(this\.ui\.statusLabel, resolvedStatus\.label\)/);
  assert.match(view, /setText\(this\.ui\.statusDetail, resolvedStatus\.detail\)/);
});
