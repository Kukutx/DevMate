'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extension = fs.readFileSync(path.resolve(__dirname, '..', 'extension.js'), 'utf8');

test('VS Code Start remains Gateway -> tunnel -> public MCP preflight -> Ready', () => {
  const start = extension.indexOf('async function quickStart(ctx)');
  const end = extension.indexOf('async function stopAll()', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /const gateway = await startGateway\(ctx\)/);
  assert.match(block, /const tunnel = await startPublicTunnel\(ctx\)/);
  assert.match(block, /const test = await mcpHandshakeTest\(publicUrl, ctx\)/);
  assert.match(block, /setStatus\('DevMate: ready'\)/);
  assert.match(block, /writeText\(test\.mcp\)/);
});

test('VS Code authenticates every public MCP preflight request and propagates session state', () => {
  const start = extension.indexOf('async function mcpHandshakeTest');
  const end = extension.indexOf('async function quickStart', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /const headers = token \? \{ Authorization: `Bearer \$\{token\}` \} : \{\}/);
  assert.match(block, /mcp-session-id/);
  assert.match(block, /MCP-Protocol-Version/);
  assert.match(block, /MCP-Session-Id/);
  assert.match(block, /tools\/list[\s\S]*8000, toolsHeaders/);
});

test('VS Code Copy URL only copies a public URL after MCP verification', () => {
  const start = extension.indexOf('async function copyUrl()');
  const end = extension.indexOf('async function copyConnectionToken', start);
  assert.ok(start >= 0 && end > start);
  const block = extension.slice(start, end);
  assert.match(block, /const test = await mcpHandshakeTest\(url, globalContext\)/);
  assert.match(block, /writeText\(test\.mcp\)/);
  assert.doesNotMatch(block, /127\.0\.0\.1/);
});
