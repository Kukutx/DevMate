'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { discoverNgrokPublicUrl } = require('../vscode-host/ngrok-agent-api.js');
const { clearTunnelController, setTunnelController, startTunnel, stopTunnel } = require('../vscode-host/tunnel-runtime.js');

function responseRequest(routes) {
  return (url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      const route = routes.find(item => String(url).endsWith(item.suffix));
      response.statusCode = route?.status ?? 404;
      response.destroy = () => {};
      callback(response);
      queueMicrotask(() => {
        if (route?.payload !== undefined) response.emit('data', Buffer.from(JSON.stringify(route.payload)));
        response.emit('end');
      });
    };
    return request;
  };
}

test('ngrok discovery falls back to the legacy tunnels Agent API shape', async () => {
  const publicUrl = await discoverNgrokPublicUrl(8788, {
    apiBase: 'http://127.0.0.1:4040/api',
    request: responseRequest([
      { suffix: '/endpoints', status: 404 },
      { suffix: '/tunnels', status: 200, payload: { tunnels: [
        { public_url: 'https://legacy.ngrok.app', config: { addr: 'http://127.0.0.1:8788' } }
      ] } }
    ]),
    timeoutMs: 250
  });
  assert.equal(publicUrl, 'https://legacy.ngrok.app');
});

test('ngrok discovery accepts alternate current upstream field names while keeping exact loopback-port checks', async () => {
  const publicUrl = await discoverNgrokPublicUrl(8788, {
    apiBase: 'http://127.0.0.1:4040/api',
    request: responseRequest([
      { suffix: '/endpoints', status: 200, payload: { endpoints: [
        { url: 'https://current.ngrok.app', upstream_url: 'http://localhost:8788' }
      ] } }
    ]),
    timeoutMs: 250
  });
  assert.equal(publicUrl, 'https://current.ngrok.app');
});

test('duplicate Start calls for one port converge on one tunnel start operation', async () => {
  let starts = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const controller = {
    logger() {},
    status() { return { running: false, owned: false, attached: false }; },
    async start() { starts += 1; await gate; return { attached: false, owned: true, publicUrl: 'https://ready.ngrok.app' }; },
    async stop() { return { stopped: true }; }
  };
  setTunnelController(controller);
  try {
    const first = startTunnel(8788);
    const second = startTunnel(8788);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.publicUrl, 'https://ready.ngrok.app');
    assert.equal(b.publicUrl, 'https://ready.ngrok.app');
  } finally {
    release?.();
    await stopTunnel().catch(() => {});
    clearTunnelController(controller);
  }
});

test('unresolved ERR_NGROK_334 is not retried by a second runtime layer', async () => {
  let starts = 0;
  const controller = {
    logger() {},
    status() { return { running: false, owned: false, attached: false }; },
    async start() {
      starts += 1;
      const error = new Error('ngrok endpoint is already online');
      error.code = 'DEVMATE_NGROK_ENDPOINT_CONFLICT';
      throw error;
    },
    async stop() { return { stopped: true }; }
  };
  setTunnelController(controller);
  try {
    await assert.rejects(() => startTunnel(8788), error => error.code === 'DEVMATE_NGROK_ENDPOINT_CONFLICT');
    assert.equal(starts, 1);
  } finally {
    await stopTunnel().catch(() => {});
    clearTunnelController(controller);
  }
});

test('source contract contains no endpoint deletion or cross-Agent ERR334 cleanup layer', () => {
  const controller = fs.readFileSync(require('node:path').join(__dirname, '..', 'vscode-host', 'tunnel-controller.js'), 'utf8');
  const agent = fs.readFileSync(require('node:path').join(__dirname, '..', 'vscode-host', 'ngrok-agent-api.js'), 'utf8');
  assert.doesNotMatch(controller, /stopConflictingLocalNgrokEndpoints|conflictRecovery|Stopped stale local ngrok endpoint/);
  assert.doesNotMatch(agent, /requestAgentDelete|localNgrokEndpointCandidatesAcrossAgents|stopConflictingLocalNgrokEndpoints/);
  assert.match(controller, /verifyExistingEndpoint/);
  assert.match(controller, /error\.conflictUrl/);
});
