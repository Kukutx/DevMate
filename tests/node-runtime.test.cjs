'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MINIMUM_NODE_MAJOR,
  nodeMajor,
  probeNodeRuntime,
  resolveNodeRuntime
} = require('../host/runtime/node-runtime.js');

function fakeSpawn(results) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    const value = results[command];
    if (value instanceof Error) return { error: value, status: null, stdout: '', stderr: '' };
    return value || { status: 1, stdout: '', stderr: 'missing' };
  };
  fn.calls = calls;
  return fn;
}

function success(node, execPath, electron = null) {
  return {
    status: 0,
    stdout: `${JSON.stringify({ node, execPath, electron })}\n`,
    stderr: ''
  };
}

test('parses current Node majors strictly', () => {
  assert.equal(MINIMUM_NODE_MAJOR, 24);
  assert.equal(nodeMajor('24.18.0'), 24);
  assert.equal(nodeMajor('v25.1.0'), 25);
  assert.equal(nodeMajor('23.9.0'), 23);
  assert.equal(nodeMajor('invalid'), 0);
});

test('probes Electron-as-Node with bounded current environment', () => {
  const spawnSyncImpl = fakeSpawn({ host: success('24.18.0', '/runtime/node', '38.0.0') });
  const result = probeNodeRuntime('host', { spawnSyncImpl });
  assert.equal(result.ok, true);
  assert.equal(result.executable, '/runtime/node');
  assert.equal(result.nodeVersion, '24.18.0');
  assert.equal(spawnSyncImpl.calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawnSyncImpl.calls[0].args.includes('--ms-enable-electron-run-as-node'), false);
  assert.ok(spawnSyncImpl.calls[0].options.timeout <= 5000);
});

test('VS Code host runtime is probed with environment-only Node mode and falls back cleanly', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const host = fakeSpawn({ [code]: success('24.18.0', code, '39.2.3') });
  const selected = resolveNodeRuntime({
    processExecutable: code,
    processNodeVersion: '24.18.0',
    spawnSyncImpl: host
  });
  assert.equal(selected.source, 'host');
  assert.equal(host.calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(host.calls[0].args.some(arg => String(arg).includes('ms-enable-electron')), false);

  const fallback = fakeSpawn({
    [code]: { status: 9, stdout: '', stderr: 'bad option' },
    node: success('24.18.0', 'C:\\Program Files\\nodejs\\node.exe')
  });
  const fallbackSelected = resolveNodeRuntime({
    processExecutable: code,
    processNodeVersion: '24.18.0',
    spawnSyncImpl: fallback
  });
  assert.equal(fallbackSelected.source, 'path');
  assert.deepEqual(fallback.calls.map(call => call.command), [code, 'node']);
});

test('auto resolution skips an old embedded Node and uses system Node 24', () => {
  const spawnSyncImpl = fakeSpawn({
    node: success('24.18.0', 'C:\\Program Files\\nodejs\\node.exe')
  });
  const result = resolveNodeRuntime({
    processExecutable: 'obsidian.exe',
    processNodeVersion: '22.17.0',
    spawnSyncImpl
  });
  assert.equal(result.source, 'path');
  assert.equal(result.nodeVersion, '24.18.0');
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node']);
});

test('configured Node wins and invalid runtimes fail closed with diagnostics', () => {
  const configured = fakeSpawn({ custom: success('25.0.0', '/custom/node') });
  const selected = resolveNodeRuntime({
    preferredExecutable: 'custom',
    processExecutable: 'host',
    processNodeVersion: '24.0.0',
    spawnSyncImpl: configured
  });
  assert.equal(selected.source, 'configured');
  assert.equal(selected.executable, '/custom/node');

  const unavailable = fakeSpawn({
    host: success('23.9.0', '/host/node'),
    node: success('22.12.0', '/path/node')
  });
  assert.throws(
    () => resolveNodeRuntime({ processExecutable: 'host', processNodeVersion: '24.0.0', spawnSyncImpl: unavailable }),
    error => error.code === 'DEVMATE_NODE_RUNTIME_UNAVAILABLE' && /Node\.js 24\+/.test(error.message)
  );
});
