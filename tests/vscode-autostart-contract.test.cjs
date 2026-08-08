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
  const start = extension.indexOf('async function quickStart(ctx)');
  const end = extension.indexOf('async function stopAll()', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);

  assert.match(block, /return \{ok:true,[^\n]*mcpUrl:test\.mcpUrl,[^\n]*toolCount:test\.toolCount/);
  assert.match(lifecycle, /commandResult = await this\.vscode\.commands\.executeCommand\('devMate\.start'/);
  assert.match(lifecycle, /!commandResult\?\.mcpUrl/);
  assert.match(lifecycle, /Number\(commandResult\?\.toolCount \|\| 0\) <= 0/);
});

test('automatic lifecycle reaches Ready from one command instead of invoking setup substeps', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  const start = lifecycle.indexOf('async startAutomatically()');
  const end = lifecycle.indexOf('async deactivate()', start);
  assert.ok(start >= 0 && end > start);
  const block = lifecycle.slice(start, end);
  assert.equal((block.match(/executeCommand\('devMate\.start'/g) || []).length, 1);
  assert.doesNotMatch(block, /connectionSetup|ngrokSetup|copyToken|copyUrl/);
});