import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { instrumentHttpListener } from '../gateway/http-observability.mjs';
import { resetMetrics } from '../gateway/observability.mjs';

test('records HTTP requests and exposes metrics only through the control route', async t => {
  resetMetrics();
  const server = http.createServer(instrumentHttpListener((req, res) => {
    res.writeHead(req.url === '/fail' ? 503 : 200, { 'content-type': 'text/plain' });
    res.end('ok');
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  assert.equal((await fetch(`${origin}/fail`)).status, 503);
  const response = await fetch(`${origin}/control/metrics`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /devmate_http_requests_total/);
  assert.match(text, /devmate_http_errors_total/);
  assert.match(response.headers.get('content-type'), /text\/plain/);
});
