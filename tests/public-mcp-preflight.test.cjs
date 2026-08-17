'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MCP_PROTOCOL_VERSION,
  mcpUrlFor,
  parseJsonPayload,
  preflightPublicMcp,
  publicEndpointLookup,
  transientPublicMcpError
} = require('../host/public-mcp.js');

function discoverResponse(id) {
  return {
    ok: true,
    status: 200,
    headers: {},
    body: '',
    json: {
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'devmate', version: '4.0.0' } }
      }
    }
  };
}

function successfulRequestRecorder(calls = []) {
  return async (url, options) => {
    calls.push({ url: String(url), options });
    const payload = JSON.parse(options.body);
    if (payload.method === 'server/discover') return discoverResponse(payload.id);
    if (payload.method === 'tools/list') {
      return {
        ok: true,
        status: 200,
        headers: {},
        body: '',
        json: { jsonrpc: '2.0', id: payload.id, result: { resultType: 'complete', tools: [{ name: 'gateway_status' }, { name: 'read_file' }] } }
      };
    }
    if (payload.method === 'tools/call' && payload.params?.name === 'gateway_status') {
      return {
        ok: true,
        status: 200,
        headers: {},
        body: '',
        json: { jsonrpc: '2.0', id: payload.id, result: { resultType: 'complete', structuredContent: { name: 'devmate', version: '4.0.0' } } }
      };
    }
    throw new Error(`Unexpected MCP request: ${options.body}`);
  };
}

test('public MCP preflight authenticates server/discover, tools/list, and a real tools/call probe without transport sessions', async () => {
  const calls = [];
  const result = await preflightPublicMcp({
    publicUrl: 'https://example.ngrok-free.app',
    token: 'short-lived-oauth-access-token',
    clientVersion: '4.0.0',
    request: successfulRequestRecorder(calls)
  });

  assert.equal(result.mcpUrl, 'https://example.ngrok-free.app/mcp');
  assert.equal(result.protocolVersion, '2026-07-28');
  assert.deepEqual(result.supportedVersions, ['2026-07-28']);
  assert.equal(result.toolCount, 2);
  assert.equal(result.toolCallVerified, true);
  assert.equal(result.probeTool, 'gateway_status');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).method), ['server/discover', 'tools/list', 'tools/call']);
  for (const call of calls) {
    assert.equal(call.options.headers.authorization, 'Bearer short-lived-oauth-access-token');
    assert.equal(call.options.headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(call.options.headers['mcp-method'], JSON.parse(call.options.body).method);
    assert.equal(Object.hasOwn(call.options.headers, 'mcp-session-id'), false);
    const meta = JSON.parse(call.options.body).params._meta;
    assert.equal(meta['io.modelcontextprotocol/protocolVersion'], MCP_PROTOCOL_VERSION);
    assert.deepEqual(meta['io.modelcontextprotocol/clientCapabilities'], {});
  }
  assert.equal(calls[2].options.headers['mcp-name'], 'gateway_status');
});

test('public MCP preflight rejects discovery-only endpoints whose tool call is broken', async () => {
  const request = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.method === 'server/discover') return discoverResponse(payload.id);
    if (payload.method === 'tools/list') {
      return { ok: true, status: 200, headers: {}, body: '', json: { result: { resultType: 'complete', tools: [{ name: 'gateway_status' }] } } };
    }
    return { ok: true, status: 200, headers: {}, body: '', json: { result: { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'broken tool execution' }] } } };
  };
  await assert.rejects(
    preflightPublicMcp({ publicUrl: 'https://broken.example', request }),
    error => error.code === 'DEVMATE_PUBLIC_MCP_TOOL_CALL_FAILED'
  );
});

test('public MCP preflight rejects servers that do not advertise MCP 2026-07-28', async () => {
  const request = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const response = discoverResponse(payload.id);
    response.json.result.supportedVersions = ['2099-01-01'];
    return response;
  };
  await assert.rejects(
    preflightPublicMcp({ publicUrl: 'https://wrong-version.example', request }),
    error => error.code === 'DEVMATE_PUBLIC_MCP_DISCOVER_FAILED'
  );
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
  let discoveries = 0;
  const request = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.method === 'server/discover' && discoveries++ < 2) {
      return { ok: false, status: 530, headers: {}, body: 'error code: 1033', error: '', json: null };
    }
    if (payload.method === 'server/discover') return discoverResponse(payload.id);
    if (payload.method === 'tools/list') {
      return { ok: true, status: 200, headers: {}, body: '', json: { result: { resultType: 'complete', tools: [{ name: 'gateway_status' }] } } };
    }
    return { ok: true, status: 200, headers: {}, body: '', json: { result: { resultType: 'complete', structuredContent: { name: 'devmate' } } } };
  };
  const result = await preflightPublicMcp({
    publicUrl: 'https://eventual.trycloudflare.com',
    request,
    readyTimeoutMs: 1000,
    retryDelayMs: 100
  });
  assert.equal(result.server.name, 'devmate');
  assert.equal(result.toolCallVerified, true);
  assert.equal(discoveries, 3);
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
