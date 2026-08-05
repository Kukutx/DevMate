'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const managedEntry = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');
const windowsEntry = fs.readFileSync(path.join(root, 'extension-entry-win32.js'), 'utf8');

test('actual VS Code Start and Stop use the shared RuntimeController', () => {
  assert.match(source, /const \{ RuntimeController, SUPPORTED_CONFIG_VERSION \} = require\('\.\/host\/runtime-controller\.js'\)/);
  assert.match(source, /gatewayController = new RuntimeController\(/);
  assert.match(source, /const result = await controller\.start\(\{timeoutMs:20000\}\)/);
  assert.match(source, /const result = await gatewayController\.stop\(\)/);
  assert.match(source, /await gatewayController\?\.dispose\(\{stopOwned:true\}\)/);
  assert.doesNotMatch(source, /function spawnNode\(/);
  assert.doesNotMatch(source, /gatewayProcess\s*=\s*spawnNode\(/);
});

test('actual VS Code process calls resolve the active spawn chain at call time', () => {
  assert.match(source, /const childProcess = require\('child_process'\)/);
  assert.match(source, /function spawn\(\.\.\.args\)\{ return childProcess\.spawn\(\.\.\.args\); \}/);
  assert.match(source, /function spawnSync\(\.\.\.args\)\{ return childProcess\.spawnSync\(\.\.\.args\); \}/);
  assert.doesNotMatch(source, /const \{ spawn, spawnSync \} = require\('child_process'\)/);
  assert.doesNotMatch(source, /version:\s*9\b/);
  assert.doesNotMatch(source, /data\.version\s*=\s*9\b/);
});

test('managed and Windows ngrok wrappers are activation-scoped SpawnLayers', () => {
  for (const entry of [managedEntry, windowsEntry]) {
    assert.match(entry, /require\('\.\/vscode-host\/spawn-layer\.js'\)/);
    assert.match(entry, /new SpawnLayer\(/);
    assert.match(entry, /\.install\(\)/);
    assert.match(entry, /\.dispose\(\)/);
    assert.match(entry, /activationAttempted/);
    assert.match(entry, /activated/);
  }
  assert.doesNotMatch(managedEntry, /loadBaseExtensionWithNgrokWrapper/);
  assert.doesNotMatch(windowsEntry, /childProcess\.spawn\s*=\s*createNgrokCredentialCompatSpawn/);
});

test('auxiliary process exit handlers cannot clear newer process handles', () => {
  assert.match(source, /if\(startCommandProcess === child\) startCommandProcess=null/);
  assert.match(source, /if\(ngrokProcess === child\)\{ ngrokProcess=null; lastPublicUrl=''; \}/);
  assert.match(source, /Leaving existing tunnel running because this VS Code host does not own its process/);
});
