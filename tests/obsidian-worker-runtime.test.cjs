'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeController } = require('../host/runtime-controller.js');
const { createWorkerSpawn } = require('../obsidian-plugin/src/worker-spawn.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('shared Worker launcher starts without an external Node executable and stops gracefully', async () => {
  const root = temporaryDirectory('devmate-worker-root-');
  const state = temporaryDirectory('devmate-worker-state-');
  const gateway = path.join(root, 'worker-gateway.mjs');
  fs.writeFileSync(gateway, `
import fs from 'node:fs';
import http from 'node:http';
import { parentPort } from 'node:worker_threads';
const config = JSON.parse(fs.readFileSync(process.env.DEVMATE_CONFIG, 'utf8'));
const server = http.createServer((request, response) => {
  if (request.url === '/control/health') {
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({name:'devmate', instanceId:config.instanceId}));
    return;
  }
  response.writeHead(404); response.end();
});
parentPort?.on('message', message => {
  if (message?.type !== 'devmate:shutdown') return;
  server.close(() => {
    parentPort.postMessage({type:'devmate:shutdown-complete'});
    process.exit(0);
  });
});
server.listen(config.server.port, '127.0.0.1');
`, 'utf8');

  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: await freePort(),
    nodeExecutable: path.join(root, 'intentionally-missing-node'),
    spawnImpl: createWorkerSpawn()
  });

  const started = await controller.start({ timeoutMs: 5000 });
  assert.equal(started.started, true);
  assert.equal(controller.owned, true);
  assert.equal(controller.lastLaunch.mode, 'worker_threads');
  assert.ok(controller.lastLaunch.readyAt);
  const startedAt = Date.now();
  const stopped = await controller.stop();
  assert.equal(stopped.stopped, true);
  assert.ok(Date.now() - startedAt < 3000, 'graceful Worker shutdown should not wait for force termination');
});

test('Worker startup failures include the underlying error and diagnostic snapshot', async () => {
  const root = temporaryDirectory('devmate-worker-error-root-');
  const state = temporaryDirectory('devmate-worker-error-state-');
  const gateway = path.join(root, 'broken-gateway.mjs');
  fs.writeFileSync(gateway, `throw new Error('synthetic worker startup failure');\n`, 'utf8');

  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: await freePort(),
    spawnImpl: createWorkerSpawn()
  });

  await assert.rejects(
    controller.start({ timeoutMs: 3000 }),
    error => {
      assert.match(error.message, /synthetic worker startup failure/);
      assert.equal(error.code, 'DEVMATE_GATEWAY_START_FAILED');
      assert.equal(error.diagnostics.lastLaunch.mode, 'worker_threads');
      return true;
    }
  );
});
