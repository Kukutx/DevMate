'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { PublicTunnelVerifier } = require('../vscode-host/public-tunnel-verifier.js');

function harness(record) {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-verifier-state-'));
  const configFile = path.join(stateDirectory, 'config.json');
  atomicWriteJson(configFile, {
    version: 11,
    instanceId: 'instance-a',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner' },
    connection: {}
  });
  fs.mkdirSync(path.join(stateDirectory, 'state'), { recursive: true });
  atomicWriteJson(path.join(stateDirectory, 'state', 'gateway.lock'), {
    version: 1,
    runtimeOwnerId: 'gateway-a',
    pid: process.pid,
    parentPid: process.ppid || process.pid,
    instanceId: 'instance-a',
    configPath: configFile,
    acquiredAt: '2026-08-08T00:59:00.000Z',
    heartbeatAt: new Date().toISOString(),
    leaseMs: 90000,
    launchMode: 'child_process'
  });
  return {
    stateDirectory,
    record,
    status(port) {
      assert.equal(port, 8787);
      return {
        running: !!this.record,
        provider: this.record?.provider || 'ngrok',
        publicUrl: this.record?.publicUrl || '',
        record: this.record
      };
    },
    cleanup() { fs.rmSync(stateDirectory, { recursive: true, force: true }); }
  };
}

test('new ready generation publishes unverified immediately before its network grace period', async () => {
  const h = harness({
    ownerId: 'owner-a', provider: 'cloudflare-quick', port: 8787,
    status: 'ready', publicUrl: 'https://new.example.com',
    readyAt: '2026-08-08T01:00:00.000Z'
  });
  const states = [];
  let preflights = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: h.stateDirectory,
      tunnelStatus: port => h.status(port),
      now: () => Date.parse('2026-08-08T01:00:01.000Z'),
      readyGraceMs: 20000,
      onStateChange: async event => states.push(event.state),
      preflight: async () => { preflights += 1; throw new Error('must stay in grace'); }
    });
    const result = await verifier.check();
    assert.equal(result.reason, 'ready-grace');
    assert.deepEqual(states, ['unverified']);
    assert.equal(preflights, 0);
  } finally {
    h.cleanup();
  }
});

test('pending provider and absent tunnel publish distinct states without attempting MCP', async () => {
  const h = harness({
    ownerId: 'owner-a', provider: 'ngrok', port: 8787,
    status: 'pending', publicUrl: '', readyAt: null
  });
  const states = [];
  let preflights = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: h.stateDirectory,
      tunnelStatus: port => h.status(port),
      onStateChange: async event => states.push(event.state),
      preflight: async () => { preflights += 1; return {}; }
    });
    assert.equal((await verifier.check()).reason, 'tunnel-pending');
    h.record = null;
    assert.equal((await verifier.check()).reason, 'no-ready-tunnel');
    assert.deepEqual(states, ['pending', 'absent']);
    assert.equal(preflights, 0);
  } finally {
    h.cleanup();
  }
});

test('state callbacks are deduplicated for the same Gateway+tunnel generation', async () => {
  const h = harness({
    ownerId: 'owner-a', provider: 'cloudflare-quick', port: 8787,
    status: 'ready', publicUrl: 'https://new.example.com',
    readyAt: '2026-08-08T01:00:00.000Z'
  });
  let states = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: h.stateDirectory,
      tunnelStatus: port => h.status(port),
      now: () => Date.parse('2026-08-08T01:00:01.000Z'),
      readyGraceMs: 20000,
      onStateChange: async () => { states += 1; }
    });
    await verifier.check();
    await verifier.check();
    assert.equal(states, 1);
  } finally {
    h.cleanup();
  }
});