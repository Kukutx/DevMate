'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { installGatewayWorkerRouter } = require('../vscode-host/gateway-spawn-router.js');

class SlowWorker extends EventEmitter {
  constructor() {
    super();
    this.threadId = 71;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
  }
  postMessage(message) { this.messages.push(message); }
  terminate() {
    queueMicrotask(() => this.emit('exit', 1));
    return Promise.resolve(1);
  }
}

test('rejects new Gateway launches and router replacement during awaited disposal', async () => {
  const extensionPath = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-router-dispose-'));
  fs.mkdirSync(path.join(extensionPath, 'gateway'));
  const entry = path.join(extensionPath, 'gateway', 'server.bundle.mjs');
  fs.writeFileSync(entry, 'export {};\n');
  const originalSpawn = () => ({ delegated: true });
  const childProcess = { spawn: originalSpawn };
  const router = installGatewayWorkerRouter({ childProcess, extensionPath, WorkerImpl: SlowWorker });
  const options = {
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      DEVMATE_CONFIG: path.join(extensionPath, 'state', 'config.json')
    }
  };
  const handle = childProcess.spawn(process.execPath, [entry], options);
  const disposing = router.dispose({ forceRestore: true });

  assert.throws(
    () => childProcess.spawn(process.execPath, [entry], options),
    error => error.code === 'DEVMATE_GATEWAY_ROUTER_DISPOSING'
  );
  assert.throws(
    () => installGatewayWorkerRouter({ childProcess, extensionPath, WorkerImpl: SlowWorker }),
    error => error.code === 'DEVMATE_GATEWAY_ROUTER_DISPOSING'
  );
  assert.equal(childProcess.spawn('git', ['status'], {}).delegated, true);

  handle.worker.emit('exit', 0);
  const result = await disposing;
  assert.equal(result.stopped.exited, 1);
  assert.equal(childProcess.spawn, originalSpawn);
});
