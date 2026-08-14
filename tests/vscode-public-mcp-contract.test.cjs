'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extension = fs.readFileSync(path.resolve(__dirname, '..', 'extension.js'), 'utf8');

test('VS Code Start remains Gateway -> tunnel -> current-generation MCP verification -> Ready', () => {
  const start = extension.indexOf('async function quickStart(ctx');
  const end = extension.indexOf('async function stopAll()', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  const gateway = block.indexOf('gateway = await startGateway(ctx)');
  const tunnel = block.indexOf('tunnel = await startPublicTunnel(ctx)');
  const verify = block.indexOf('await verifyCurrentTunnel(publicUrl, tunnel.record, ctx)');
  const readySync = block.indexOf('await syncPublicUiState(ctx)');
  const copy = block.indexOf('await vscode.env.clipboard.writeText(test.mcpUrl)');
  assert.ok(gateway >= 0 && tunnel > gateway && verify > tunnel && readySync > verify && copy > readySync);
  assert.match(block, /mcpUrl:test\.mcpUrl/);
  assert.match(block, /toolCount:test\.toolCount/);
  assert.match(block, /rollbackFailedStart/);
});

test('VS Code explicit verification binds evidence to the exact current complete session generation', () => {
  const start = extension.indexOf('async function verifyCurrentTunnel');
  const end = extension.indexOf('function recordConnectionFailure', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /const generation = recordGeneration\(expectedRecord\)/);
  assert.match(block, /const test = await verifyPublicMcp\(publicUrl, ctx, \{/);
  assert.match(block, /readyTimeoutMs: 15000/);
  assert.match(block, /shouldContinue: \(\) => recordGeneration\(currentTunnelRecord\(expectedRecord\.port\)\) === generation/);
  assert.match(block, /recordGeneration\(currentRecord\) !== generation/);
  assert.match(block, /successfulVerificationPatch\(test, publicUrl, stamp, expectedRecord\)/);
  assert.match(block, /verifiedForCurrentRecord\(persisted, currentRecord\)/);
  assert.match(block, /throw staleSessionGenerationError\(\)/);
  assert.doesNotMatch(block, /staleTunnelGenerationError/);
});

test('VS Code delegates authenticated public MCP protocol handling to the shared helper', () => {
  assert.match(extension, /const \{ preflightPublicMcp \} = require\('\.\/host\/public-mcp\.js'\)/);
  const start = extension.indexOf('async function verifyPublicMcp');
  const end = extension.indexOf('async function verifyCurrentTunnel', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /const data = ctx \? ensureConfig\(ctx,false\) : null/);
  assert.match(block, /return preflightPublicMcp\(\{/);
  assert.match(block, /publicUrl: baseUrl/);
  assert.match(block, /token: data\?\.auth\?\.required === false \? '' : String\(data\?\.auth\?\.token \|\| ''\)/);
  assert.match(block, /clientName: 'devmate-vscode-preflight'/);
  assert.match(block, /clientVersion: VERSION/);
  assert.doesNotMatch(block, /method\s*:\s*'initialize'/);
  assert.doesNotMatch(block, /method\s*:\s*'tools\/list'/);
});

test('VS Code Copy URL verifies and commits current generation before clipboard copy', () => {
  const start = extension.indexOf('async function copyUrl()');
  const end = extension.indexOf('async function copyConnectionToken', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  const verify = block.indexOf('await verifyCurrentTunnel(url, status.record, globalContext)');
  const readySync = block.indexOf('await syncPublicUiState(globalContext)');
  const copy = block.indexOf('await vscode.env.clipboard.writeText(verified.test.mcpUrl)');
  assert.ok(verify >= 0 && readySync > verify && copy > readySync);
  assert.doesNotMatch(block, /127\.0\.0\.1/);
});

test('clipboard convenience cannot turn a verified Start into a failed lifecycle', () => {
  const start = extension.indexOf('async function quickStart(ctx');
  const end = extension.indexOf('async function stopAll()', start);
  const block = extension.slice(start, end);
  const verify = block.indexOf('await verifyCurrentTunnel(publicUrl, tunnel.record, ctx)');
  const copyTry = block.indexOf('try{', block.indexOf("if(cfg().get('autoCopyUrl'))"));
  const success = block.indexOf('return {ok:true');
  assert.ok(verify >= 0 && copyTry > verify && success > copyTry);
  assert.match(block, /copyError = String\(error\.message \|\| error\)/);
});
