'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_MAX_RESPONSE_BYTES,
  MIN_MAX_RESPONSE_BYTES,
  requestRaw
} = require('../vscode-host/bounded-http-client.js');

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

test('returns bounded JSON responses with byte metadata', async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  try {
    const result = await requestRaw(`${fixture.url}/health`, {}, null, 1000, 64 * 1024);
    assert.equal(result.ok, true);
    assert.deepEqual(result.json, { ok: true });
    assert.equal(result.bytes, Buffer.byteLength(result.body));
    assert.equal(result.maxBytes, 64 * 1024);
  } finally {
    await close(fixture.server);
  }
});

test('rejects advertised and chunked oversized responses without unbounded buffering', async () => {
  const advertised = await listen((_request, response) => {
    response.writeHead(200, { 'content-length': String(128 * 1024) });
    response.end('small');
  });
  try {
    const result = await requestRaw(advertised.url, {}, null, 1000, 4096);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'response-too-large');
    assert.equal(result.contentLength, 128 * 1024);
    assert.equal(result.maxBytes, 4096);
  } finally {
    await close(advertised.server);
  }

  const chunked = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.write(Buffer.alloc(3000));
    response.write(Buffer.alloc(3000));
    response.end(Buffer.alloc(3000));
  });
  try {
    const result = await requestRaw(chunked.url, {}, null, 1000, 4096);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'response-too-large');
    assert.ok(result.bytes > result.maxBytes);
  } finally {
    await close(chunked.server);
  }
});

test('uses an absolute deadline even when a server keeps sending data', async () => {
  const fixture = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => response.write('x'), 20);
    timer.unref?.();
    response.once('close', () => clearInterval(timer));
  });
  const started = Date.now();
  try {
    const result = await requestRaw(fixture.url, {}, null, 120, 64 * 1024);
    const elapsed = Date.now() - started;
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.ok(elapsed >= 50 && elapsed < 1000, `Unexpected total deadline: ${elapsed}ms`);
    assert.ok(result.bytes > 0);
  } finally {
    await close(fixture.server);
  }
});

test('normalizes unsafe limits and rejects invalid protocols and URLs', async () => {
  const fixture = await listen((_request, response) => response.end('ok'));
  try {
    const minimum = await requestRaw(fixture.url, {}, null, 1000, 1);
    assert.equal(minimum.maxBytes, MIN_MAX_RESPONSE_BYTES);
    const maximum = await requestRaw(fixture.url, {}, null, 1000, Number.MAX_SAFE_INTEGER);
    assert.equal(maximum.maxBytes, MAX_MAX_RESPONSE_BYTES);
    const fallback = await requestRaw(fixture.url, {}, null, 1000, Number.NaN);
    assert.equal(fallback.maxBytes, DEFAULT_MAX_RESPONSE_BYTES);
  } finally {
    await close(fixture.server);
  }

  const protocol = await requestRaw('ftp://example.test/file');
  assert.equal(protocol.ok, false);
  assert.match(protocol.error, /unsupported protocol/);
  const invalid = await requestRaw('not a url');
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /bad url/);
});
