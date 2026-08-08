'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mcpUrlFor,
  parseJsonPayload,
  preflightPublicMcp
} = require('../host/public-mcp.js');

test('public MCP preflight authenticates initialize and tools/list and carries the MCP session', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: String(url), options });
    const payload = JSON.parse(options.body);
    if (payload.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        headers: { 'mcp-session-id': 'session-123' },
        body: '',
        json: {
          jsonrpc: '2.0',
          id: 1,
          result: { serverInfo: { name: 'devmate', version: '3.3.0' } }
        }
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {},
      body: '',
      json: { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'read_file' }] } }
    };
  };

  const result = await preflightPublicMcp({
    publicUrl: 'https://example.ngrok-free.app',
    token: 'owner-secret',
    clientVersion: '3.3.0',
    request
  });

  assert.equal(result.mcpUrl, 'https://example.ngrok-free.app/mcp');
  assert.equal(result.toolCount, 1);
  assert.equal(result.sessionId, 'session-123');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.authorization, 'Bearer owner-secret');
  assert.equal(calls[1].options.headers.authorization, 'Bearer owner-secret');
  assert.equal(calls[1].options.headers['mcp-session-id'], 'session-123');
  assert.equal(calls[1].options.headers['mcp-protocol-version'], '2025-03-26');
});

test('public MCP URL accepts only a clean HTTPS origin', () => {
  assert.equal(mcpUrlFor('https://demo.ngrok-free.app/'), 'https://demo.ngrok-free.app/mcp');
  assert.throws(() => mcpUrlFor('http://127.0.0.1:8787'), /must use HTTPS/);
  assert.throws(() => mcpUrlFor('https://demo.ngrok-free.app/path'), /must not contain a path/);
});

test('public MCP response parsing accepts JSON and SSE data frames', () => {
  assert.deepEqual(parseJsonPayload('{"ok":true}'), { ok: true });
  assert.deepEqual(
    parseJsonPayload('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n'),
    { jsonrpc: '2.0', id: 1, result: {} }
  );
});
