'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ObsidianNgrokRuntime } = require('../obsidian-plugin/src/ngrok-runtime.js');

class FakeChild extends EventEmitter {
  constructor(pid = 4242) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = 'SIGTERM') {
    if (this.exitCode != null) return false;
    this.killed = true;
    this.signalCode = signal;
    this.exitCode = 0;
    queueMicrotask(() => {
      this.emit('exit', 0, signal);
      this.emit('close', 0, signal);
    });
    return true;
  }
}

function fakeChildProcess() {
  const launches = [];
  return {
    launches,
    spawnSync(command, args) {
      launches.push({ kind: 'check', command, args });
      return { status: 0, stdout: 'ngrok version 3.0.0\n', stderr: '' };
    },
    spawn(command, args, options) {
      const child = new FakeChild();
      launches.push({ kind: 'spawn', command, args, options, child });
      return child;
    }
  };
}

function fakeNgrokApi(publicUrl = 'https://devmate-test.ngrok-free.app') {
  return (url, options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = () => {};
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      response.destroy = () => {};
      callback(response);
      queueMicrotask(() => {
        response.emit('data', Buffer.from(JSON.stringify({
          tunnels: [{
            public_url: publicUrl,
            config: { addr: 'http://127.0.0.1:8787' }
          }]
        })));
        response.emit('end');
      });
    };
    return request;
  };
}

test('Obsidian ngrok runtime starts a real provider lifecycle and publishes shared HTTPS state', async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-ngrok-'));
  const childProcess = fakeChildProcess();
  const plugin = {
    settings: {
      ngrokCommandPath: 'ngrok',
      ngrokUrl: '',
      ngrokPoolingEnabled: false,
      ngrokAuthtokenEncrypted: '',
      tunnelAutoRestart: true,
      tunnelMaxRestarts: 3
    },
    controller: {
      readConfig: () => ({ deployment: { mode: 'personal' } })
    }
  };
  const runtime = new ObsidianNgrokRuntime({
    plugin,
    stateDirectory,
    childProcess,
    httpRequest: fakeNgrokApi(),
    controllerOptions: {
      readyTimeoutMs: 1500,
      startTimeoutMs: 1500,
      stopTimeoutMs: 500,
      forceStopTimeoutMs: 250,
      heartbeatMs: 5000
    }
  });

  try {
    const started = await runtime.start(8787);
    assert.equal(started.owned, true);
    assert.equal(started.attached, false);
    assert.equal(started.publicUrl, 'https://devmate-test.ngrok-free.app');

    const status = runtime.status(8787);
    assert.equal(status.running, true);
    assert.equal(status.owned, true);
    assert.equal(status.provider, 'ngrok');
    assert.equal(status.publicUrl, started.publicUrl);

    const launch = childProcess.launches.find(item => item.kind === 'spawn');
    assert.ok(launch);
    assert.equal(launch.command, 'ngrok');
    assert.deepEqual(launch.args.slice(0, 2), ['http', '8787']);
    assert.equal(Object.prototype.hasOwnProperty.call(launch.options.env, 'NGROK_AUTHTOKEN'), false);

    const stopped = await runtime.stop();
    assert.equal(stopped.stopped, true);
    assert.equal(runtime.status(8787).running, false);
  } finally {
    await runtime.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
