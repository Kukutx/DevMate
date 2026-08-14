'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  mcpUrlFor,
  parseJsonPayload,
  preflightPublicMcp,
  publicEndpointLookup,
  transientPublicMcpError
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

test('public MCP preflight retries only transient tunnel propagation failures', async () => {
  let attempts = 0;
  const request = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.method === 'initialize' && attempts++ < 2) {
      return { ok: false, status: 530, headers: {}, body: 'error code: 1033', error: '', json: null };
    }
    if (payload.method === 'initialize') {
      return { ok: true, status: 200, headers: {}, body: '', json: { result: { serverInfo: { name: 'devmate' } } } };
    }
    return { ok: true, status: 200, headers: {}, body: '', json: { result: { tools: [] } } };
  };
  const result = await preflightPublicMcp({
    publicUrl: 'https://eventual.trycloudflare.com',
    request,
    readyTimeoutMs: 1000,
    retryDelayMs: 100
  });
  assert.equal(result.server.name, 'devmate');
  assert.equal(attempts, 3);
  assert.equal(transientPublicMcpError({ response: { status: 401 } }), false);
  assert.equal(transientPublicMcpError({ response: { error: 'getaddrinfo ENOTFOUND edge.example' } }), true);
});

test('Cloudflare quick endpoints bypass the Windows lookup cache without changing other providers', async () => {
  const calls = [];
  const resolver = {
    lookup(hostname, options, callback) {
      calls.push(['lookup', hostname, options]);
      callback(null, '203.0.113.10', 4);
    },
    resolve4(hostname, callback) {
      calls.push(['resolve4', hostname]);
      callback(null, ['203.0.113.20']);
    }
  };
  const cloudflare = await new Promise((resolve, reject) => {
    publicEndpointLookup('fresh.trycloudflare.com', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    }, resolver);
  });
  const ngrok = await new Promise((resolve, reject) => {
    publicEndpointLookup('example.ngrok-free.app', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    }, resolver);
  });
  assert.deepEqual(cloudflare, { address: '203.0.113.20', family: 4 });
  assert.deepEqual(ngrok, { address: '203.0.113.10', family: 4 });
  assert.deepEqual(calls.map(call => call[0]), ['resolve4', 'lookup']);
});
