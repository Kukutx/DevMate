'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

test('runtime contains no legacy state migration API or forwarding entry layers', () => {
  const forbidden = new RegExp(['migrate', 'Legacy', 'State'].join(''));
  const legacyDirectory = new RegExp(['legacy', 'Directory'].join(''));
  for (const file of [
    'host/runtime/state-paths.js',
    'vscode-host/runtime-context.js',
    'obsidian-plugin/src/main.js'
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, forbidden, file);
    assert.doesNotMatch(text, legacyDirectory, file);
  }
  assert.equal(fs.existsSync(path.join(root, 'extension-entry-host.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'devmate-cli.mjs')), false);
  const statePaths = require('../host/runtime/state-paths.js');
  assert.equal(Object.keys(statePaths).some(key => forbidden.test(key)), false);
});

test('host runtime cannot fall back to retired host or per-extension modes', () => {
  assert.doesNotMatch(source('host/runtime/state-paths.js'), /localDirectory|shared\s*=/);
  assert.doesNotMatch(source('vscode-host/runtime-context.js'), /sharedRuntimeEnabled|localDirectory/);
  assert.doesNotMatch(source('vscode-host/lifecycle.js'), /vscodeHostEnabled|sharedRuntimeEnabled/);
  assert.doesNotMatch(source('obsidian-plugin/src/settings.js'), /sharedRuntime/);
  assert.doesNotMatch(source('package.json'), /vscodeHostEnabled|sharedRuntimeEnabled/);
});

test('Gateway shared modules require the current DEVMATE_CONFIG contract', () => {
  assert.doesNotMatch(source('gateway/local-shared.mjs'), /AIWG_CONFIG/);
});
