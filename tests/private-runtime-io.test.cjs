'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const runtimeIo = require('../vscode-host/runtime-io.js');
const { SpawnLayer } = require('../vscode-host/spawn-layer.js');
const { defaultTransports } = require('../vscode-host/bounded-http-client.js');

const globalSpawn = childProcess.spawn;
const globalSpawnSync = childProcess.spawnSync;
const globalHttpRequest = http.request;
const root = path.resolve(__dirname, '..');

function source(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test.afterEach(() => {
  runtimeIo.reset();
  assert.equal(childProcess.spawn, globalSpawn);
  assert.equal(childProcess.spawnSync, globalSpawnSync);
  assert.equal(http.request, globalHttpRequest);
});

test('runtime adapter wrappers never mutate Node process-global modules', () => {
  const calls = [];
  runtimeIo.spawn = (...args) => { calls.push(['spawn', ...args]); return 'spawned'; };
  runtimeIo.spawnSync = (...args) => { calls.push(['spawnSync', ...args]); return { status: 0 }; };
  runtimeIo.httpRequest = (...args) => { calls.push(['http', ...args]); return 'request'; };

  assert.equal(childProcess.spawn, globalSpawn);
  assert.equal(childProcess.spawnSync, globalSpawnSync);
  assert.equal(http.request, globalHttpRequest);
  assert.equal(runtimeIo.spawn('cmd', ['a']), 'spawned');
  assert.deepEqual(runtimeIo.spawnSync('cmd', ['b']), { status: 0 });
  assert.equal(runtimeIo.httpRequest('http://localhost'), 'request');
  assert.deepEqual(calls.map(item => item[0]), ['spawn', 'spawnSync', 'http']);
  assert.equal(runtimeIo.isNative(), false);
});

test('VS Code Electron gets its required Node-mode flag only for the Gateway entry', () => {
  const executable = process.platform === 'win32' ? 'C:\\Program Files\\Microsoft VS Code\\Code.exe' : '/opt/vscode/code';
  const gateway = process.platform === 'win32'
    ? 'C:\\extensions\\devmate\\gateway\\server.bundle.mjs'
    : '/extensions/devmate/gateway/server.bundle.mjs';
  const ordinary = process.platform === 'win32' ? 'C:\\workspace\\script.mjs' : '/workspace/script.mjs';
  const options = { electronVersion: '39.2.3', processExecutable: executable };

  assert.deepEqual(
    runtimeIo.decorateGatewaySpawnArgs(executable, [gateway], options),
    [runtimeIo.VSCODE_ELECTRON_NODE_FLAG, gateway]
  );
  assert.deepEqual(
    runtimeIo.decorateGatewaySpawnArgs(executable, [runtimeIo.VSCODE_ELECTRON_NODE_FLAG, gateway], options),
    [runtimeIo.VSCODE_ELECTRON_NODE_FLAG, gateway],
    'flag must never be duplicated'
  );
  assert.deepEqual(
    runtimeIo.decorateGatewaySpawnArgs(executable, [ordinary], options),
    [ordinary],
    'unrelated VS Code child processes must not be decorated'
  );
  assert.deepEqual(
    runtimeIo.decorateGatewaySpawnArgs(executable, [gateway], { ...options, electronVersion: '' }),
    [gateway],
    'normal Node must not receive a VS Code-only Electron flag'
  );
  assert.deepEqual(
    runtimeIo.decorateGatewaySpawnArgs('node', [gateway], options),
    [gateway],
    'an explicit system Node executable must remain unchanged'
  );
});

test('SpawnLayer composes on the private adapter without touching global child_process', () => {
  const calls = [];
  runtimeIo.spawn = () => { calls.push('base'); return 'ok'; };
  const layer = new SpawnLayer({
    childProcess: runtimeIo,
    name: 'private-layer',
    wrap: previous => (...args) => {
      calls.push('layer');
      return previous(...args);
    }
  }).install();

  assert.equal(runtimeIo.spawn('cmd'), 'ok');
  assert.deepEqual(calls, ['layer', 'base']);
  assert.equal(childProcess.spawn, globalSpawn);
  layer.dispose();
  assert.equal(runtimeIo.spawn('cmd'), 'ok');
  assert.deepEqual(calls, ['layer', 'base', 'base']);
});

test('bounded HTTP default transport resolves the current private adapter dynamically', () => {
  const calls = [];
  runtimeIo.httpRequest = (...args) => { calls.push(args); return 'fake-request'; };
  const transports = defaultTransports();
  assert.equal(transports.http.request('http://127.0.0.1/test'), 'fake-request');
  assert.equal(calls.length, 1);
  assert.equal(http.request, globalHttpRequest);
});

test('runtime adapter rejects non-callable replacements and resets atomically', () => {
  assert.throws(() => { runtimeIo.spawn = null; }, /spawn must be a function/);
  assert.throws(() => { runtimeIo.spawnSync = 1; }, /spawnSync must be a function/);
  assert.throws(() => { runtimeIo.httpRequest = {}; }, /httpRequest must be a function/);
  runtimeIo.spawn = () => null;
  runtimeIo.spawnSync = () => null;
  runtimeIo.httpRequest = () => null;
  runtimeIo.reset();
  assert.equal(runtimeIo.isNative(), true);
});

test('VS Code runtime IO is explicit and setup layers never monkey patch adapters or Node globals', () => {
  const files = [
    'extension.js',
    'extension-entry.js',
    'extension-entry-platform.js',
    'vscode-host/tunnel-controller.js',
    'vscode-host/bounded-http-client.js'
  ];
  for (const relative of files) {
    const text = source(relative);
    assert.doesNotMatch(text, /\bchildProcess\.(?:spawn|spawnSync)\s*=/, relative);
    assert.doesNotMatch(text, /\bhttp\.request\s*=/, relative);
    assert.doesNotMatch(text, /runtimeIo\.(?:spawn|spawnSync|httpRequest)\s*=/, relative);
  }

  assert.match(source('extension.js'), /require\('\.\/vscode-host\/runtime-io\.js'\)/);
  assert.match(source('vscode-host/bounded-http-client.js'), /require\('\.\/runtime-io\.js'\)/);
  assert.match(source('vscode-host/runtime-io.js'), /--ms-enable-electron-run-as-node/);
  assert.match(source('vscode-host/runtime-io.js'), /isGatewayEntry/);

  assert.doesNotMatch(source('extension-entry.js'), /runtime-io\.js|SpawnLayer|installManagedSpawnLayer/);
  assert.doesNotMatch(source('extension-entry-platform.js'), /runtime-io\.js|installProcessWrappers|TunnelCompatibilityManager/);
  assert.match(source('vscode-host/tunnel-controller.js'), /require\('node:child_process'\)/);
});
