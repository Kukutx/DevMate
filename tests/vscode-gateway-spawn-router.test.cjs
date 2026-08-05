'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  gatewayLaunchDetails,
  installGatewayWorkerRouter
} = require('../vscode-host/gateway-spawn-router.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class FakeWorker extends EventEmitter {
  constructor(entry, options) {
    super();
    this.entry = entry;
    this.options = options;
    this.threadId = 17;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    queueMicrotask(() => this.emit('online'));
  }
  terminate() {
    queueMicrotask(() => this.emit('exit', 0));
    return Promise.resolve(0);
  }
}

test('routes only the bundled authenticated Gateway launch to a Worker', async () => {
  const extensionPath = temporaryDirectory('devmate-vscode-router-');
  const gatewayDirectory = path.join(extensionPath, 'gateway');
  fs.mkdirSync(gatewayDirectory);
  const entry = path.join(gatewayDirectory, 'server.bundle.mjs');
  fs.writeFileSync(entry, 'export {};\n');
  const delegated = [];
  const childProcess = {
    spawn(command, args, options) {
      delegated.push({ command, args, options });
      return { delegated: true };
    }
  };
  const events = [];
  const router = installGatewayWorkerRouter({
    childProcess,
    extensionPath,
    WorkerImpl: FakeWorker,
    diagnostics: {
      append(message) { events.push(message); },
      recordFailure(error) { throw error; }
    }
  });

  const options = {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DEVMATE_CONFIG: path.join(extensionPath, 'state', 'config.json')
    }
  };
  const handle = childProcess.spawn(process.execPath, [entry], options);
  assert.equal(handle.launchMode, 'worker_threads');
  assert.equal(handle.entry, entry);
  assert.equal(delegated.length, 0);
  assert.equal(router.isGatewayLaunch(process.execPath, [entry], options), true);
  assert.match(events.join('\n'), /embedded VS Code Gateway Worker/i);

  const exited = new Promise(resolve => handle.once('exit', resolve));
  assert.equal(handle.kill(), true);
  await exited;
  router.dispose();
});

test('delegates unrelated, untrusted, or escaping launches unchanged', () => {
  const extensionPath = temporaryDirectory('devmate-vscode-delegate-');
  const gatewayDirectory = path.join(extensionPath, 'gateway');
  fs.mkdirSync(gatewayDirectory);
  const outside = path.join(temporaryDirectory('devmate-outside-'), 'server.bundle.mjs');
  fs.writeFileSync(outside, 'export {};\n');
  const sentinel = { delegated: true };
  const originalSpawn = () => sentinel;
  const childProcess = { spawn: originalSpawn };
  const router = installGatewayWorkerRouter({ childProcess, extensionPath, WorkerImpl: FakeWorker });

  const baseOptions = { env: { ELECTRON_RUN_AS_NODE: '1', DEVMATE_CONFIG: path.join(extensionPath, 'config.json') } };
  assert.equal(childProcess.spawn('git', ['status'], {}), sentinel);
  assert.equal(childProcess.spawn(process.execPath, [outside], baseOptions), sentinel);
  assert.equal(childProcess.spawn(process.execPath, [path.join(gatewayDirectory, 'other.mjs')], baseOptions), sentinel);
  assert.equal(childProcess.spawn(process.execPath, [path.join(gatewayDirectory, 'server.mjs')], { env: {} }), sentinel);
  assert.equal(gatewayLaunchDetails(process.execPath, [outside], baseOptions, { extensionPath }), null);

  router.dispose();
  assert.equal(childProcess.spawn, originalSpawn);
});

test('router installation is idempotent and disposal terminates owned Workers', async () => {
  const extensionPath = temporaryDirectory('devmate-vscode-idempotent-');
  fs.mkdirSync(path.join(extensionPath, 'gateway'));
  const entry = path.join(extensionPath, 'gateway', 'server.mjs');
  fs.writeFileSync(entry, 'export {};\n');
  const childProcess = { spawn() { throw new Error('unexpected delegate'); } };
  const first = installGatewayWorkerRouter({ childProcess, extensionPath, WorkerImpl: FakeWorker });
  const second = installGatewayWorkerRouter({ childProcess, extensionPath, WorkerImpl: FakeWorker });
  assert.equal(first, second);
  const handle = childProcess.spawn(process.execPath, [entry], {
    env: { ELECTRON_RUN_AS_NODE: '1', DEVMATE_CONFIG: path.join(extensionPath, 'config.json') }
  });
  const exited = new Promise(resolve => handle.once('exit', resolve));
  first.dispose();
  await exited;
  assert.equal(handle.killed, true);
});
