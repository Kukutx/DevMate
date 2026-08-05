'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');

test('actual VS Code tunnel lifecycle uses the shared coordinator', () => {
  assert.match(source, /const \{ TunnelRuntimeCoordinator \} = require\('\.\/host\/runtime\/tunnel-coordinator\.js'\)/);
  assert.match(source, /tunnelController = new TunnelRuntimeCoordinator\(/);
  assert.match(source, /const result=await controller\.start\(\{/);
  assert.match(source, /const result=await tunnelController\.stop\(\)/);
  assert.match(source, /tunnelController\?\.status\(\)\.record\?\.publicUrl/);
  assert.match(source, /await tunnelController\?\.dispose\(\{stopOwned:true\}\)/);
});

test('attached VS Code windows cannot stop or delete another host tunnel', () => {
  assert.match(source, /Leaving shared tunnel running because another host owns it/);
  assert.match(source, /if\(!result\.stopped\)/);
  assert.match(source, /for\(const t of tunnels\)\{/);
  assert.match(source, /ngrokProcess=result\.owned \? result\.child : null/);
});

test('tunnel identity includes provider and endpoint-affecting settings', () => {
  for (const setting of [
    'tunnelProvider',
    'publicUrl',
    'ngrokUrl',
    'ngrokCommandPath',
    'ngrokTrafficPolicyFile',
    'cloudflareCommandPath',
    'ngrokPoolingEnabled'
  ]) {
    assert.match(source, new RegExp(`get\\('${setting}'\\)`), `Missing ${setting} from tunnel configuration identity`);
  }
});
