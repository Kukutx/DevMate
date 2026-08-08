'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Obsidian Start closes Gateway, ngrok, public preflight and verified-copy lifecycle', () => {
  const main = source('obsidian-plugin/src/main.js');
  assert.match(main, /const gateway = await this\.controller\.start\(\)/);
  assert.match(main, /const tunnel = await this\.ngrokRuntime\.start\(gateway\.port\)/);
  assert.match(main, /const preflight = await this\.verifyPublicEndpoint\(publicUrl\)/);
  assert.match(main, /await navigator\.clipboard\.writeText\(preflight\.mcpUrl\)/);
  assert.match(main, /state: verified \? 'ready' : 'public-unverified'/);
  assert.doesNotMatch(main, /ownerUrl\(this\.settings\.publicOrigin\)/);
  assert.doesNotMatch(main, /this\.settings\.publicOrigin|settings\.publicOrigin/);
});

test('Obsidian Copy MCP URL never falls back to localhost or an unverified configured origin', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async copyConnectionUrl()');
  const end = main.indexOf('async copyConnectionToken()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /this\.ngrokRuntime\?\.status\(gateway\.port\)/);
  assert.match(block, /await this\.verifyPublicEndpoint\(publicUrl\)/);
  assert.match(block, /writeText\(test\.mcpUrl\)/);
  assert.doesNotMatch(block, /127\.0\.0\.1|ownerUrl|this\.settings\.publicOrigin|settings\.publicOrigin/);
});

test('Obsidian UI labels loopback as internal and surfaces public ngrok MCP separately', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /connectionDetail\('Public MCP'\)/);
  assert.match(view, /connectionDetail\('ngrok'\)/);
  assert.match(view, /connectionDetail\('Internal Gateway'\)/);
  assert.match(view, /internal only/);
});

test('Obsidian current build and settings are ngrok-first and Node 24', () => {
  const settings = source('obsidian-plugin/src/settings.js');
  const build = source('obsidian-plugin/esbuild.config.mjs');
  assert.match(settings, /autoCopyUrl: true/);
  assert.match(settings, /ngrokCommandPath/);
  assert.match(settings, /ngrokAuthtokenEncrypted/);
  assert.doesNotMatch(settings, /publicOrigin/);
  assert.match(build, /target: 'node24'/);
  assert.doesNotMatch(build, /target: 'node18'/);
});
