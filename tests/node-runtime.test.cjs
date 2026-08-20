'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MINIMUM_NODE_MAJOR,
  PROBE_MAX_BUFFER_BYTES,
  PROBE_TIMEOUT_MS,
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
  assert.equal(PROBE_TIMEOUT_MS, 2000);
  assert.equal(nodeMajor('24.19.0'), 24);
  assert.equal(nodeMajor('v26.7.0'), 26);
  assert.equal(nodeMajor('23.9.0'), 23);
  assert.equal(nodeMajor('invalid'), 0);
});

test('runtime probes are tightly bounded and force-terminated on timeout', () => {
  const spawnSyncImpl = fakeSpawn({ host: success('24.19.0', '/runtime/node', '43.4.0') });
  const result = probeNodeRuntime('host', { spawnSyncImpl });
  assert.equal(result.ok, true);
  assert.equal(result.executable, '/runtime/node');
  assert.equal(result.nodeVersion, '24.19.0');
  const options = spawnSyncImpl.calls[0].options;
  assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(options.killSignal, 'SIGKILL');
  assert.equal(options.maxBuffer, PROBE_MAX_BUFFER_BYTES);
  assert.equal(options.timeout, PROBE_TIMEOUT_MS);
  assert.equal(spawnSyncImpl.calls[0].args.includes('--ms-enable-electron-run-as-node'), false);
});

test('standalone Node is preferred over the editor host runtime', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const spawnSyncImpl = fakeSpawn({
    node: success('24.19.0', 'C:\\Program Files\\nodejs\\node.exe'),
    [code]: success('24.19.0', code, '43.4.0')
  });
  const selected = resolveNodeRuntime({ processExecutable: code, spawnSyncImpl });
  assert.equal(selected.source, 'path');
  assert.equal(selected.executable, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node']);
});

test('host runtime remains a verified fallback when standalone Node is unavailable', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const spawnSyncImpl = fakeSpawn({
    node: { status: 1, stdout: '', stderr: 'not found' },
    [code]: success('24.19.0', code, '43.4.0')
  });
  const selected = resolveNodeRuntime({ processExecutable: code, spawnSyncImpl });
  assert.equal(selected.source, 'host');
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node', code]);
  assert.equal(spawnSyncImpl.calls[1].options.env.ELECTRON_RUN_AS_NODE, '1');
});

test('configured Node wins and invalid runtimes fail closed with diagnostics', () => {
  const configured = fakeSpawn({ custom: success('26.7.0', '/custom/node') });
  const selected = resolveNodeRuntime({
    preferredExecutable: 'custom',
    processExecutable: 'host',
    spawnSyncImpl: configured
  });
  assert.equal(selected.source, 'configured');
  assert.equal(selected.executable, '/custom/node');

  const unavailable = fakeSpawn({
    node: success('22.23.2', '/path/node'),
    host: success('23.9.0', '/host/node')
  });
  assert.throws(
    () => resolveNodeRuntime({ processExecutable: 'host', spawnSyncImpl: unavailable }),
    error => error.code === 'DEVMATE_NODE_RUNTIME_UNAVAILABLE' && /Node\.js 24\+/.test(error.message)
  );
});
