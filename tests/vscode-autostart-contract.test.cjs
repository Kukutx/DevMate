'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('real VS Code Start returns Ready evidence and keeps project activation explicit', () => {
  const extension = source('extension.js');
  const lifecycle = source('vscode-host/lifecycle.js');
  const start = extension.indexOf('async function quickStart(ctx,{quiet=false,activateWorkspace=true}={})');
  const end = extension.indexOf('async function stopAll()', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);

  assert.match(block, /gateway = await startGateway\(ctx,\{activateWorkspace\}\)/);
  assert.match(block, /return \{ok:true,[^\n]*mcpUrl:test\.mcpUrl,[^\n]*toolCount:test\.toolCount/);
  assert.match(block, /activatedWorkspace:activateWorkspace/);
  assert.match(block, /const data = ensureConfig\(ctx,false\);[\s\S]*publicConnectionStability\(\{provider:tunnel\.provider,publicUrl:data\.connection\?\.publicUrl \|\| ''\}\)/);
  assert.match(block, /if\(!quiet\)\{[\s\S]*vscode\.window\.showErrorMessage/);
  assert.match(lifecycle, /activateWorkspaceOnAutoStart\(\)[\s\S]*setting\(this\.vscode, 'activateWorkspaceOnAutoStart', false\) === true/);
  assert.match(lifecycle, /commandResult = await this\.vscode\.commands\.executeCommand\('devMate\.start', \{ quiet: true, activateWorkspace \}\)/);
  assert.match(lifecycle, /!commandResult\?\.mcpUrl/);
  assert.match(lifecycle, /!Number\.isInteger\(Number\(commandResult\?\.toolCount\)\)/);
  assert.match(lifecycle, /Number\(commandResult\.toolCount\) <= 0/);
});

test('VS Code Gateway start attaches without changing Current Project when activation is disabled', () => {
  const extension = source('extension.js');
  const start = extension.indexOf('async function startGateway(ctx,{activateWorkspace=true}={})');
  const end = extension.indexOf('function currentTunnelStatus', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /if\(activateWorkspace\) controller\.activateWorkspace\(\);/);
  assert.match(block, /else controller\.ensureConfig\(\);/);
  assert.match(block, /syncConfig\(ctx,activateWorkspace\)/);
});

test('automatic lifecycle reaches Ready from one command instead of invoking setup substeps', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  const start = lifecycle.indexOf('async startAutomatically(');
  const end = lifecycle.indexOf('async deactivate({ preserveSession = true } = {})', start);
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
