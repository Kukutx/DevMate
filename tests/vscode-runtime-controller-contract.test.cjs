'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const managedEntry = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');

test('actual VS Code Start and Stop use the shared RuntimeController', () => {
  assert.match(source, /const \{ RuntimeController, SUPPORTED_CONFIG_VERSION \} = require\('\.\/host\/runtime-controller\.js'\)/);
  assert.match(source, /gatewayController = new RuntimeController\(/);
  assert.match(source, /const result = await controller\.start\(\{timeoutMs:20000\}\)/);
  assert.match(source, /const result = await gatewayController\.stop\(\)/);
  assert.match(source, /await gatewayController\?\.dispose\(\{stopOwned:true\}\)/);
  assert.doesNotMatch(source, /function spawnNode\(/);
  assert.doesNotMatch(source, /gatewayProcess\s*=\s*spawnNode\(/);
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

test('managed ngrok wrapper is an activation-scoped SpawnLayer', () => {
  assert.match(managedEntry, /require\('\.\/vscode-host\/spawn-layer\.js'\)/);
  assert.match(managedEntry, /require\('\.\/vscode-host\/runtime-io\.js'\)/);
  assert.match(managedEntry, /new SpawnLayer\(/);
  assert.match(managedEntry, /\.install\(\)/);
  assert.match(managedEntry, /\.dispose\(\)/);
  assert.match(managedEntry, /activationAttempted/);
  assert.match(managedEntry, /activated/);
  assert.doesNotMatch(managedEntry, /loadBaseExtensionWithNgrokWrapper/);
});

test('auxiliary process exit handlers cannot clear newer process handles', () => {
  assert.match(source, /if\(startCommandProcess === child\) startCommandProcess=null/);
  assert.match(source, /if\(ngrokProcess === child\)\{ ngrokProcess=null; lastPublicUrl=''; \}/);
  assert.match(source, /Leaving existing tunnel running because this VS Code host does not own its process/);
});
