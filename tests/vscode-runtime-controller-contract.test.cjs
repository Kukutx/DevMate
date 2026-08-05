'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');

test('actual VS Code Start and Stop use the shared RuntimeController', () => {
  assert.match(source, /const \{ RuntimeController \} = require\('\.\/host\/runtime-controller\.js'\)/);
  assert.match(source, /gatewayController = new RuntimeController\(/);
  assert.match(source, /const result = await controller\.start\(\{timeoutMs:20000\}\)/);
  assert.match(source, /const result = await gatewayController\.stop\(\)/);
  assert.match(source, /await gatewayController\?\.dispose\(\{stopOwned:true\}\)/);
  assert.doesNotMatch(source, /function spawnNode\(/);
  assert.doesNotMatch(source, /gatewayProcess\s*=\s*spawnNode\(/);
});

test('auxiliary process exit handlers cannot clear newer process handles', () => {
  assert.match(source, /if\(startCommandProcess === child\) startCommandProcess=null/);
  assert.match(source, /if\(ngrokProcess === child\)\{ ngrokProcess=null; lastPublicUrl=''; \}/);
  assert.match(source, /Leaving existing tunnel running because this VS Code host does not own its process/);
});
