'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { discoverLocalNgrokEndpoint } = require('../vscode-host/ngrok-agent-api.js');
const { TunnelController } = require('../vscode-host/tunnel-controller.js');

function response(status = 404, payload) {
  return callback => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.destroy = () => {};
    callback(res);
    queueMicrotask(() => {
      if (payload !== undefined) res.emit('data', Buffer.from(JSON.stringify(payload)));
      res.emit('end');
    });
  };
}

function secondaryAgentRequest(url, _options, callback) {
  const req = new EventEmitter();
  req.setTimeout = () => {};
  req.destroy = () => {};
  req.end = () => {
    const target = String(url);
    if (target === 'http://127.0.0.1:4041/api/endpoints') {
      return response(200, {
        endpoints: [{
          id: 'previous-devmate',
          url: 'https://existing.ngrok.app',
          upstream: { url: 'http://127.0.0.1:8788' }
        }]
      })(callback);
    }
    return response(404)(callback);
  };
  return req;
}

function childProcessThatMustNotSpawn() {
  return {
    spawn() {
      throw new Error('new ngrok process must not be spawned when a reusable endpoint already exists');
    },
    spawnSync(_command, args) {
      if (args[0] === 'version') return { status: 0, stdout: 'ngrok version 3.40.0\n', stderr: '' };
      if (args[0] === 'config' && args[1] === 'check') return { status: 1, stdout: '', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    }
  };
}

function settings() {
  return {
    provider: 'ngrok',
    ngrokCommandPath: 'ngrok',
    ngrokUseManagedAccount: false,
    ngrokPoolingEnabled: false,
    autoRestart: false,
    maxRestarts: 0
  };
}

test('cross-Agent discovery returns the actual Agent API that owns a same-port endpoint', async () => {
  const endpoint = await discoverLocalNgrokEndpoint(8788, {
    apiBase: 'http://127.0.0.1:4040/api',
    request: secondaryAgentRequest,
    timeoutMs: 150,
    firstPort: 4040,
    lastPort: 4042
  });
  assert.deepEqual(endpoint, {
    publicUrl: 'https://existing.ngrok.app',
    apiBase: 'http://127.0.0.1:4041/api'
  });
});

test('TunnelController reuses a same-port endpoint from a secondary Agent before spawning ngrok', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-secondary-agent-reuse-'));
  const controller = new TunnelController({
    stateDirectory,
    settings,
    childProcess: childProcessThatMustNotSpawn(),
    httpRequest: secondaryAgentRequest,
    readyTimeoutMs: 1000,
    startTimeoutMs: 2000
  });
  try {
    const started = await controller.start(8788);
    assert.equal(started.attached, true);
    assert.equal(started.owned, false);
    assert.equal(started.publicUrl, 'https://existing.ngrok.app');
    assert.equal(controller.borrowedAgentApiBase, 'http://127.0.0.1:4041/api');
    assert.equal(controller.status(8788).running, true);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
