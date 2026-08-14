'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('desktop hosts use a stable workspace-specific instance identity instead of one shared key', () => {
  const vscode = source('extension.js');
  const obsidian = source('obsidian-plugin/src/main.js');
  assert.match(vscode, /function vscodeHostInstanceId\(root=currentRoot\(\)\)/);
  assert.match(vscode, /vscode-\$\{workspaceRuntimeId\(root\)\}-\$\{process\.pid\}/);
  assert.match(vscode, /hostId: vscodeHostInstanceId\(root\)/);
  assert.match(obsidian, /this\.hostInstanceId = `obsidian-\$\{workspaceRuntimeId\(this\.vaultRoot\)\}-\$\{process\.pid\}`/);
  assert.match(obsidian, /hostId: this\.hostInstanceId/);
  assert.doesNotMatch(obsidian, /const HOST_ID = 'obsidian'/);
});

test('each Obsidian Vault registers and removes only its own authenticated bridge record', () => {
  const bridge = source('obsidian-plugin/src/bridge/server.js');
  assert.match(bridge, /this\.hostId = String\(plugin\.hostInstanceId \|\| controller\.hostId \|\| 'obsidian'\)/);
  assert.match(bridge, /config\.hostBridges\[this\.hostId\] = \{/);
  assert.match(bridge, /config\.hostBridges\?\.\[this\.hostId\]\?\.token === token/);
  assert.doesNotMatch(bridge, /config\.hostBridges\.obsidian =/);
});

test('the Gateway resolves the current VS Code context across isolated host records and legacy config', () => {
  const gateway = source('gateway/server.mjs');
  const start = gateway.indexOf('function vscodeContext(cfg)');
  const end = gateway.indexOf('function now()', start);
  const block = gateway.slice(start, end);
  assert.match(block, /context\?\.kind === 'editor'/);
  assert.match(block, /cfg\.activeHostId/);
  assert.match(block, /cfg\.vscodeContext/);
});
