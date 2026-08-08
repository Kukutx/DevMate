'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extension = fs.readFileSync(path.resolve(__dirname, '..', 'extension.js'), 'utf8');

test('VS Code Start remains Gateway -> tunnel -> shared public MCP preflight -> verified Ready state', () => {
  const start = extension.indexOf('async function quickStart(ctx)');
  const end = extension.indexOf('async function stopAll()', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  const gateway = block.indexOf('const gateway = await startGateway(ctx)');
  const tunnel = block.indexOf('const tunnel = await startPublicTunnel(ctx)');
  const preflight = block.indexOf('const test = await verifyPublicMcp(publicUrl, ctx)');
  const evidence = block.indexOf('successfulVerificationPatch(test, publicUrl, stamp)');
  assert.ok(gateway >= 0 && tunnel > gateway && preflight > tunnel && evidence > preflight);
  assert.match(block, /writeText\(test\.mcpUrl\)/);
  assert.match(block, /Ready\. Verified MCP URL:/);
});

test('VS Code delegates authenticated public MCP preflight and session handling to the shared helper', () => {
  assert.match(extension, /const \{ preflightPublicMcp \} = require\('\.\/host\/public-mcp\.js'\)/);
  const start = extension.indexOf('async function verifyPublicMcp');
  const end = extension.indexOf('async function quickStart', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /return preflightPublicMcp\(\{/);
  assert.match(block, /publicUrl/);
  assert.match(block, /token: mcpToken\(ctx\)/);
  assert.match(block, /clientName: 'devmate-vscode-preflight'/);
  assert.match(block, /clientVersion: VERSION/);
  assert.doesNotMatch(block, /method\s*:\s*'initialize'/);
  assert.doesNotMatch(block, /method\s*:\s*'tools\/list'/);
});

test('VS Code Copy URL only copies a public URL after shared MCP verification', () => {
  const start = extension.indexOf('async function copyUrl()');
  const end = extension.indexOf('async function copyConnectionToken', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  const preflight = block.indexOf('const test = await verifyPublicMcp(url, globalContext)');
  const copy = block.indexOf('await vscode.env.clipboard.writeText(test.mcpUrl)');
  assert.ok(preflight >= 0 && copy > preflight);
  assert.match(block, /successfulVerificationPatch\(test, url, stamp\)/);
  assert.doesNotMatch(block, /127\.0\.0\.1/);
});
