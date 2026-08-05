'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { MAX_HTTP_JSON_BYTES, httpJson } = require('../host/runtime/network.js');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('parses bounded JSON responses', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name: 'devmate', ok: true }));
  });
  const port = await listen(server);
  try {
    const result = await httpJson(`http://127.0.0.1:${port}/control/health`, 1000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, { name: 'devmate', ok: true });
    assert.ok(result.bytes > 0);
  } finally {
    await close(server);
  }
});

test('destroys oversized health responses before unbounded accumulation', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    const chunk = Buffer.alloc(8192, 120);
    for (let i = 0; i < 20; i += 1) response.write(chunk);
    response.end();
  });
  const port = await listen(server);
  try {
    const result = await httpJson(`http://127.0.0.1:${port}/control/health`, 1000);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'response-too-large');
    assert.equal(result.maxBytes, MAX_HTTP_JSON_BYTES);
    assert.ok(result.bytes > MAX_HTTP_JSON_BYTES);
    assert.equal(result.text, '');
  } finally {
    await close(server);
  }
});
