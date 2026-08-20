'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MINIMUM_NODE_MAJOR,
  GATEWAY_RUNTIME_PROBE_KIND,
  nodeMajor,
  probeNodeRuntime,
  probeGatewayRuntime,
  resolveNodeRuntime
} = require('../host/runtime/node-runtime.js');

const gatewayEntry = __filename;

function fakeSpawn(handler) {
  const calls = [];
  const fn = (command, args, options) => {
    calls.push({ command, args, options });
    const value = handler(command, args, options, calls.length - 1);
    if (value instanceof Error) return { error: value, status: null, stdout: '', stderr: '' };
    return value || { status: 1, stdout: '', stderr: 'missing' };
  };
  fn.calls = calls;
  return fn;
}

function versionSuccess(node, execPath, electron = null) {
  return {
    status: 0,
    stdout: `${JSON.stringify({ node, execPath, electron })}\n`,
    stderr: ''
  };
}

function gatewaySuccess(node = '24.18.0', electron = null) {
  return {
    status: 0,
    stdout: `${JSON.stringify({
      kind: GATEWAY_RUNTIME_PROBE_KIND,
      ok: true,
      node,
      electron,
      platform: process.platform,
      arch: process.arch,
      platformCapabilities: true
    })}\n`,
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

test('probes Electron-as-Node version metadata without private Electron flags', () => {
  const spawnSyncImpl = fakeSpawn(() => versionSuccess('24.18.0', '/runtime/node', '42.8.0'));
  const result = probeNodeRuntime('host', { spawnSyncImpl });
  assert.equal(result.ok, true);
  assert.equal(result.executable, '/runtime/node');
  assert.equal(result.nodeVersion, '24.18.0');
  assert.equal(spawnSyncImpl.calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawnSyncImpl.calls[0].args.includes('--ms-enable-electron-run-as-node'), false);
});

test('Gateway capability probe is side-effect isolated and requires the Gateway contract marker', () => {
  const spawnSyncImpl = fakeSpawn(() => gatewaySuccess('24.18.0', '42.8.0'));
  const result = probeGatewayRuntime('/runtime/node', { gatewayEntry, spawnSyncImpl });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'gateway-bootstrap');
  assert.equal(spawnSyncImpl.calls[0].args[0], gatewayEntry);
  assert.equal(spawnSyncImpl.calls[0].options.env.DEVMATE_RUNTIME_PROBE, '1');
  assert.equal(spawnSyncImpl.calls[0].options.env.DEVMATE_CONFIG, '');
  assert.equal(spawnSyncImpl.calls[0].options.env.DEVMATE_DISABLE_INSTANCE_LOCK, '1');

  const invalid = probeGatewayRuntime('/runtime/node', {
    gatewayEntry,
    spawnSyncImpl: fakeSpawn(() => ({ status: 0, stdout: '{"ok":true}\n', stderr: '' }))
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /no valid capability result/i);
});

test('missing packaged Gateway fails before probing any runtime candidate', () => {
  const spawnSyncImpl = fakeSpawn(() => versionSuccess('24.18.0', '/runtime/node'));
  assert.throws(
    () => resolveNodeRuntime({ gatewayEntry: `${__filename}.missing`, spawnSyncImpl }),
    error => error.code === 'DEVMATE_GATEWAY_RUNTIME_PROBE_MISSING' && /runtime probe entry is missing/i.test(error.message)
  );
  assert.equal(spawnSyncImpl.calls.length, 0);
});

test('automatic resolution prefers standalone Node and does not bind Gateway lifecycle to VS Code', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === 'node' && args[0] === '-p') return versionSuccess('24.18.0', node);
    if (command === node && args[0] === gatewayEntry) return gatewaySuccess();
    if (command === code) throw new Error('VS Code host must not be probed when standalone Node satisfies the contract');
    return null;
  });
  const selected = resolveNodeRuntime({
    processExecutable: code,
    processNodeVersion: '24.18.0',
    spawnSyncImpl,
    gatewayEntry
  });
  assert.equal(selected.source, 'path');
  assert.equal(selected.executable, node);
  assert.equal(selected.gatewayProbe.ok, true);
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node', node]);
});

test('host Electron is only a fallback and must run the packaged Gateway probe successfully', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === 'node') return { status: 1, stdout: '', stderr: 'node not found' };
    if (command === code && args[0] === '-p') return versionSuccess('24.18.0', code, '42.8.0');
    if (command === code && args[0] === gatewayEntry) return gatewaySuccess('24.18.0', '42.8.0');
    return null;
  });
  const selected = resolveNodeRuntime({
    processExecutable: code,
    processNodeVersion: '24.18.0',
    spawnSyncImpl,
    gatewayEntry
  });
  assert.equal(selected.source, 'host');
  assert.equal(selected.gatewayProbe.ok, true);
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node', code, code]);
});

test('a host that reports Node 24 but cannot bootstrap Gateway is rejected instead of hanging at Start', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === 'node') return { status: 1, stdout: '', stderr: 'node not found' };
    if (command === code && args[0] === '-p') return versionSuccess('24.18.0', code, '42.8.0');
    if (command === code && args[0] === gatewayEntry) {
      const timeout = new Error('spawnSync Code.exe ETIMEDOUT');
      timeout.code = 'ETIMEDOUT';
      return timeout;
    }
    return null;
  });

  assert.throws(
    () => resolveNodeRuntime({
      processExecutable: code,
      processNodeVersion: '24.18.0',
      spawnSyncImpl,
      gatewayEntry
    }),
    error => {
      assert.equal(error.code, 'DEVMATE_GATEWAY_RUNTIME_UNAVAILABLE');
      assert.match(error.message, /Gateway-compatible Node\.js 24\+/);
      assert.equal(error.attempts.at(-1).source, 'host');
      assert.equal(error.attempts.at(-1).stage, 'gateway-bootstrap');
      assert.match(error.attempts.at(-1).reason, /ETIMEDOUT/);
      return true;
    }
  );
});

test('configured runtime remains authoritative only when it satisfies the same Gateway contract', () => {
  const configured = '/custom/node';
  const system = '/system/node';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === configured && args[0] === '-p') return versionSuccess('25.0.0', configured);
    if (command === configured && args[0] === gatewayEntry) return gatewaySuccess('25.0.0');
    if (command === 'node' && args[0] === '-p') return versionSuccess('24.18.0', system);
    if (command === system && args[0] === gatewayEntry) return gatewaySuccess();
    return null;
  });
  const selected = resolveNodeRuntime({
    preferredExecutable: configured,
    processExecutable: 'host',
    processNodeVersion: '24.0.0',
    spawnSyncImpl,
    gatewayEntry
  });
  assert.equal(selected.source, 'configured');
  assert.equal(selected.executable, configured);
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), [configured, configured]);
});
