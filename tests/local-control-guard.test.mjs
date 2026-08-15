import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { guardLocalControlListener } from '../gateway/local-control-guard.mjs';
import { instrumentHttpListener } from '../gateway/http-observability.mjs';
import { resetMetrics } from '../gateway/observability.mjs';

function request(port, path, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { host }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('local control guard requires both loopback socket and loopback Host', async t => {
  let innerCalls = 0;
  const server = http.createServer(guardLocalControlListener((req, res) => {
    innerCalls += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(req.url);
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const localHealth = await request(port, '/control/health', `127.0.0.1:${port}`);
  assert.equal(localHealth.status, 200);
  assert.equal(innerCalls, 1);

  const proxiedHealth = await request(port, '/control/health', 'devmate.example.com');
  assert.equal(proxiedHealth.status, 403);
  assert.match(proxiedHealth.body, /local control endpoint only/);
  assert.equal(proxiedHealth.headers['cache-control'], 'no-store');
  assert.equal(innerCalls, 1, 'public-Host control request reached the inner Gateway listener');

  const proxiedMetrics = await request(port, '/control/metrics', 'devmate.example.com');
  assert.equal(proxiedMetrics.status, 403);
  assert.equal(innerCalls, 1, 'public-Host metrics request reached the inner Gateway listener');

  const publicMcp = await request(port, '/mcp', 'devmate.example.com');
  assert.equal(publicMcp.status, 200);
  assert.equal(innerCalls, 2, 'non-control routes must remain available to later ingress guards');
});

test('observability layer independently rejects proxied access to control metrics', async t => {
  resetMetrics();
  const server = http.createServer(instrumentHttpListener((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const local = await request(port, '/control/metrics', `localhost:${port}`);
  assert.equal(local.status, 200);
  assert.match(local.body, /devmate_http_inflight/);

  const proxied = await request(port, '/control/metrics', 'devmate.example.com');
  assert.equal(proxied.status, 403);
  assert.equal(proxied.headers['cache-control'], 'no-store');
});
