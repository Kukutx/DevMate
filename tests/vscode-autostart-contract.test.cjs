'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('real VS Code Start returns the Ready evidence required by automatic lifecycle', () => {
  const extension = source('extension.js');
  const lifecycle = source('vscode-host/lifecycle.js');
  const start = extension.indexOf('async function quickStart(ctx,{quiet=false}={})');
  const end = extension.indexOf('async function stopAll()', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);

  assert.match(block, /return \{ok:true,[^\n]*mcpUrl:test\.mcpUrl,[^\n]*toolCount:test\.toolCount/);
  assert.match(block, /if\(!quiet\) vscode\.window\.showErrorMessage/);
  assert.match(lifecycle, /commandResult = await this\.vscode\.commands\.executeCommand\('devMate\.start', \{ quiet: true \}\)/);
  assert.match(lifecycle, /!commandResult\?\.mcpUrl/);
  assert.match(lifecycle, /!Number\.isInteger\(Number\(commandResult\?\.toolCount\)\)/);
  assert.match(lifecycle, /Number\(commandResult\.toolCount\) <= 0/);
});

test('automatic lifecycle reaches Ready from one command instead of invoking setup substeps', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  const start = lifecycle.indexOf('async startAutomatically(');
  const end = lifecycle.indexOf('async deactivate()', start);
  assert.ok(start >= 0 && end > start);
  const block = lifecycle.slice(start, end);
  assert.equal((block.match(/executeCommand\('devMate\.start'/g) || []).length, 1);
  assert.doesNotMatch(block, /connectionSetup|ngrokSetup|copyToken|copyUrl/);
});
test('automatic Start is fenced by the current VS Code host lifecycle generation', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  assert.match(lifecycle, /this\.lifecycleGeneration = 0/);
  assert.match(lifecycle, /const generation = this\.lifecycleGeneration/);
  assert.match(lifecycle, /!this\.active \|\| generation !== this\.lifecycleGeneration/);
  assert.match(lifecycle, /this\.startAutomatically\(generation\)/);
  assert.match(lifecycle, /this\.active = false;\s*this\.lifecycleGeneration \+= 1;/);
  assert.match(lifecycle, /handleStartupFailure\(error, generation/);
});
