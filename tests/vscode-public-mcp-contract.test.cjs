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

test('VS Code explicit verification binds evidence to the exact current tunnel generation and private OAuth secret state', () => {
  const start = extension.indexOf('async function verifyCurrentTunnel');
  const end = extension.indexOf('function recordConnectionFailure', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /return verifySharedPublicMcp\(\{/);
  assert.match(block, /stateDirectory: path\.dirname\(configPath\(ctx\)\)/);
  assert.match(block, /configFile: configPath\(ctx\)/);
  assert.match(block, /expectedRecord/);
  assert.match(block, /currentRecord: \(\) => currentTunnelRecord\(expectedRecord\?\.port\)/);
  assert.match(block, /token: preflightAccessToken\(data, publicUrl, configPath\(ctx\)\)/);
  assert.match(block, /clientName: 'devmate-vscode-preflight'/);
});

test('VS Code delegates authenticated public MCP protocol and cross-host single-flight handling to the shared helper', () => {
  assert.match(extension, /const \{ verifySharedPublicMcp \} = require\('\.\/host\/shared-public-mcp-verification\.js'\)/);
  const start = extension.indexOf('async function verifyCurrentTunnel');
  const end = extension.indexOf('function recordConnectionFailure', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /return verifySharedPublicMcp\(\{/);
  assert.match(block, /publicUrl/);
  assert.match(block, /clientName: 'devmate-vscode-preflight'/);
  assert.match(block, /clientVersion: VERSION/);
  assert.doesNotMatch(block, /method\s*:\s*'initialize'/);
  assert.doesNotMatch(block, /method\s*:\s*'tools\/list'/);
});

test('VS Code Copy URL verifies and commits current generation before clipboard copy', () => {
  const start = extension.indexOf('async function copyUrl()');
  const end = extension.indexOf('async function copyStarterPrompt()', start);
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

test('temporary public failures preserve the current URL for automatic recovery', () => {
  const start = extension.indexOf('async function quickStart(ctx');
  const end = extension.indexOf('async function stopAll()', start);
  const block = extension.slice(start, end);
  assert.match(block, /const recovering = transientPublicMcpError\(e\)/);
  assert.match(block, /preserveConnection:recovering/);
  assert.match(block, /showWarningMessage\(summary/);
});

test('VS Code product copy distinguishes a temporary public connection from a persistent ChatGPT app address', () => {
  assert.match(extension, /publicConnectionStability/);
  assert.match(extension, /temporary session MCP URL/);
  assert.match(extension, /persistent ChatGPT MCP URL/);
  assert.match(extension, /current-session share/);
});
