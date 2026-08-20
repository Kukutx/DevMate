'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MINIMUM_NODE_MAJOR,
  GATEWAY_RUNTIME_PROBE_KIND,
  GATEWAY_RUNTIME_CONTRACT_VERSION,
  nodeMajor,
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

function gatewaySuccess(node = '24.18.0', execPath = '/runtime/node', electron = null) {
  return {
    status: 0,
    stdout: `${JSON.stringify({
      kind: GATEWAY_RUNTIME_PROBE_KIND,
      contractVersion: GATEWAY_RUNTIME_CONTRACT_VERSION,
      ok: true,
      node,
      execPath,
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
  assert.equal(GATEWAY_RUNTIME_CONTRACT_VERSION, 1);
  assert.equal(nodeMajor('24.18.0'), 24);
  assert.equal(nodeMajor('v25.1.0'), 25);
  assert.equal(nodeMajor('23.9.0'), 23);
  assert.equal(nodeMajor('invalid'), 0);
});

test('Gateway capability probe is the only runtime eligibility check', () => {
  const spawnSyncImpl = fakeSpawn(() => gatewaySuccess('24.18.0', '/runtime/node', '42.8.0'));
  const result = probeGatewayRuntime('host', { gatewayEntry, spawnSyncImpl });
  assert.equal(result.ok, true);
  assert.equal(result.stage, 'gateway-contract');
  assert.equal(result.contractVersion, 1);
  assert.equal(result.executable, '/runtime/node');
  assert.equal(result.nodeVersion, '24.18.0');
  assert.deepEqual(spawnSyncImpl.calls[0].args, [gatewayEntry]);
  assert.equal(spawnSyncImpl.calls[0].options.killSignal, 'SIGKILL');
  assert.equal(spawnSyncImpl.calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(spawnSyncImpl.calls[0].options.env.DEVMATE_RUNTIME_PROBE, '1');
  assert.equal(spawnSyncImpl.calls[0].options.env.DEVMATE_CONFIG, '');
  assert.equal(Object.hasOwn(spawnSyncImpl.calls[0].options.env, 'DEVMATE_DISABLE_INSTANCE_LOCK'), false);
  assert.equal(Object.hasOwn(spawnSyncImpl.calls[0].options.env, 'DEVMATE_DISABLE_EMBEDDED_RUNNER'), false);
  assert.equal(spawnSyncImpl.calls[0].args.includes('-p'), false);
  assert.equal(spawnSyncImpl.calls[0].args.includes('--ms-enable-electron-run-as-node'), false);
});

test('Gateway capability probe requires the exact versioned contract', () => {
  const invalid = probeGatewayRuntime('/runtime/node', {
    gatewayEntry,
    spawnSyncImpl: fakeSpawn(() => ({
      status: 0,
      stdout: `${JSON.stringify({
        kind: GATEWAY_RUNTIME_PROBE_KIND,
        contractVersion: 2,
        ok: true,
        node: '24.18.0',
        execPath: '/runtime/node',
        platformCapabilities: true
      })}\n`,
      stderr: ''
    }))
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /contract v1/i);
});

test('Gateway capability probe enforces Node 24 from the real Gateway process', () => {
  const result = probeGatewayRuntime('/runtime/node', {
    gatewayEntry,
    spawnSyncImpl: fakeSpawn(() => gatewaySuccess('23.9.0', '/runtime/node'))
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Node 24\+ is required/);
});

test('missing packaged Gateway fails before probing any runtime candidate', () => {
  const spawnSyncImpl = fakeSpawn(() => gatewaySuccess());
  assert.throws(
    () => resolveNodeRuntime({ gatewayEntry: `${__filename}.missing`, spawnSyncImpl }),
    error => error.code === 'DEVMATE_GATEWAY_RUNTIME_PROBE_MISSING' && /runtime probe entry is missing/i.test(error.message)
  );
  assert.equal(spawnSyncImpl.calls.length, 0);
});

test('automatic resolution prefers standalone Node with one real Gateway probe', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === 'node' && args[0] === gatewayEntry) return gatewaySuccess('24.18.0', node);
    if (command === code) throw new Error('VS Code host must not be probed when standalone Node satisfies the contract');
    return null;
  });
  const selected = resolveNodeRuntime({ processExecutable: code, spawnSyncImpl, gatewayEntry });
  assert.equal(selected.source, 'path');
  assert.equal(selected.executable, node);
  assert.equal(selected.contractVersion, 1);
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node']);
});

test('host Electron is only a fallback and receives the same Gateway contract probe', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === 'node') return { status: 1, stdout: '', stderr: 'node not found' };
    if (command === code && args[0] === gatewayEntry) return gatewaySuccess('24.18.0', code, '42.8.0');
    return null;
  });
  const selected = resolveNodeRuntime({ processExecutable: code, spawnSyncImpl, gatewayEntry });
  assert.equal(selected.source, 'host');
  assert.equal(selected.executable, code);
  assert.equal(selected.electronVersion, '42.8.0');
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), ['node', code]);
});

test('a host that cannot execute the Gateway is rejected before normal Start', () => {
  const code = 'A:\\Software Development\\Microsoft VS Code\\Code.exe';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === 'node') return { status: 1, stdout: '', stderr: 'node not found' };
    if (command === code && args[0] === gatewayEntry) {
      const timeout = new Error('spawnSync Code.exe ETIMEDOUT');
      timeout.code = 'ETIMEDOUT';
      return timeout;
    }
    return null;
  });

  assert.throws(
    () => resolveNodeRuntime({ processExecutable: code, spawnSyncImpl, gatewayEntry }),
    error => {
      assert.equal(error.code, 'DEVMATE_GATEWAY_RUNTIME_UNAVAILABLE');
      assert.match(error.message, /Gateway-compatible Node\.js 24\+/);
      assert.equal(error.attempts.at(-1).source, 'host');
      assert.equal(error.attempts.at(-1).stage, 'gateway-contract');
      assert.match(error.attempts.at(-1).reason, /ETIMEDOUT/);
      return true;
    }
  );
});

test('configured runtime remains authoritative only when it satisfies the same Gateway contract', () => {
  const configured = '/custom/node';
  const spawnSyncImpl = fakeSpawn((command, args) => {
    if (command === configured && args[0] === gatewayEntry) return gatewaySuccess('25.0.0', configured);
    if (command === 'node') throw new Error('PATH Node must not be probed after configured runtime succeeds');
    return null;
  });
  const selected = resolveNodeRuntime({
    preferredExecutable: configured,
    processExecutable: 'host',
    spawnSyncImpl,
    gatewayEntry
  });
  assert.equal(selected.source, 'configured');
  assert.equal(selected.executable, configured);
  assert.equal(selected.nodeVersion, '25.0.0');
  assert.deepEqual(spawnSyncImpl.calls.map(call => call.command), [configured]);
});
