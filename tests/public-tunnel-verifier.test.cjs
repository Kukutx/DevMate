'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson, readJson } = require('../shared/config-store.cjs');
const { gatewayGeneration } = require('../shared/public-ingress-verification.cjs');
const { PublicTunnelVerifier } = require('../vscode-host/public-tunnel-verifier.js');

function writeGatewayLock(stateDirectory, overrides = {}) {
  const state = path.join(stateDirectory, 'state');
  fs.mkdirSync(state, { recursive: true });
  const lock = {
    version: 1,
    runtimeOwnerId: 'gateway-a',
    pid: process.pid,
    parentPid: process.ppid || process.pid,
    instanceId: 'instance-a',
    configPath: path.join(stateDirectory, 'config.json'),
    acquiredAt: '2026-08-08T00:59:00.000Z',
    heartbeatAt: new Date().toISOString(),
    leaseMs: 90000,
    launchMode: 'child_process',
    ...overrides
  };
  atomicWriteJson(path.join(state, 'gateway.lock'), lock);
  return lock;
}

function fixture() {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-public-verifier-'));
  const configFile = path.join(stateDirectory, 'config.json');
  const config = {
    version: 11,
    instanceId: 'instance-a',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner-token' },
    connection: {
      lastPreflightAt: '2026-08-08T00:00:00.000Z',
      lastPublicHost: 'old.example.com',
      lastMcpPath: '/mcp',
      lastToolCount: 10,
      lastServerName: 'devmate'
    }
  };
  atomicWriteJson(configFile, config);
  writeGatewayLock(stateDirectory);
  let record = {
    ownerId: 'owner-a',
    hostId: 'vscode-a',
    provider: 'cloudflare-quick',
    port: 8787,
    status: 'ready',
    publicUrl: 'https://new.example.com',
    readyAt: '2026-08-08T01:00:00.000Z'
  };
  return {
    stateDirectory,
    configFile,
    get record() { return record; },
    set record(value) { record = value; },
    status(port) {
      assert.equal(port, 8787);
      return { running: true, publicUrl: record.publicUrl, record };
    },
    writeGateway(overrides = {}) { return writeGatewayLock(stateDirectory, overrides); },
    cleanup() { fs.rmSync(stateDirectory, { recursive: true, force: true }); }
  };
}

function successfulTest(publicUrl, toolCount = 42) {
  return {
    publicOrigin: publicUrl,
    mcpUrl: `${publicUrl}/mcp`,
    toolCount,
    server: { name: 'devmate', version: '3.3.0' }
  };
}

test('new Gateway+tunnel generation is authenticated and atomically becomes the current verified endpoint', async () => {
  const fx = fixture();
  let call = null;
  let verifiedEvent = null;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      appVersion: '3.3.0',
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: async input => {
        call = input;
        return successfulTest(input.publicUrl);
      },
      onVerified: async event => { verifiedEvent = event; }
    });
    const result = await verifier.check();
    assert.equal(result.verified, true);
    assert.equal(result.changedHost, true);
    assert.equal(call.token, 'owner-token');
    assert.equal(call.clientName, 'devmate-vscode-runtime-recovery');
    assert.equal(call.publicUrl, 'https://new.example.com');
    assert.equal(verifiedEvent.publicHost, 'new.example.com');

    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastPreflightAt, '2026-08-08T01:01:00.000Z');
    assert.equal(config.connection.lastPublicOrigin, 'https://new.example.com');
    assert.equal(config.connection.lastPublicHost, 'new.example.com');
    assert.equal(config.connection.lastMcpPath, '/mcp');
    assert.equal(config.connection.lastToolCount, 42);
    assert.equal(config.connection.lastServerName, 'devmate');
    assert.equal(config.connection.lastError, '');
    assert.equal(config.connection.lastGatewayGeneration, gatewayGeneration(fx.writeGateway()));
    assert.ok(config.connection.lastTunnelGeneration);
  } finally {
    fx.cleanup();
  }
});

test('preflight result is discarded if tunnel generation changes while verification is in flight', async () => {
  const fx = fixture();
  let resolvePreflight;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: () => new Promise(resolve => { resolvePreflight = resolve; })
    });
    const pending = verifier.check();
    await new Promise(resolve => setImmediate(resolve));
    fx.record = {
      ...fx.record,
      ownerId: 'owner-b',
      publicUrl: 'https://later.example.com',
      readyAt: '2026-08-08T01:00:30.000Z'
    };
    resolvePreflight(successfulTest('https://new.example.com'));
    const result = await pending;
    assert.equal(result.stale, true);
    assert.equal(result.verified, false);

    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastPublicHost, 'old.example.com');
    assert.equal(config.connection.lastPreflightAt, '2026-08-08T00:00:00.000Z');
  } finally {
    fx.cleanup();
  }
});

test('disposing the verifier fences an in-flight preflight from persisting or notifying after teardown', async () => {
  const fx = fixture();
  let resolvePreflight;
  let verifiedNotices = 0;
  let errorNotices = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: () => new Promise(resolve => { resolvePreflight = resolve; }),
      onVerified: async () => { verifiedNotices += 1; },
      onError: async () => { errorNotices += 1; }
    });
    const pending = verifier.check();
    await new Promise(resolve => setImmediate(resolve));
    verifier.dispose();
    resolvePreflight(successfulTest('https://new.example.com'));
    const result = await pending;
    assert.equal(result.verified, false);
    assert.equal(result.stale, true);
    assert.equal(result.reason, 'verifier-stopped');
    assert.equal(verifiedNotices, 0);
    assert.equal(errorNotices, 0);

    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastPublicHost, 'old.example.com');
    assert.equal(config.connection.lastPreflightAt, '2026-08-08T00:00:00.000Z');
  } finally {
    fx.cleanup();
  }
});

test('Gateway generation change during preflight discards otherwise successful evidence', async () => {
  const fx = fixture();
  let resolvePreflight;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: () => new Promise(resolve => { resolvePreflight = resolve; })
    });
    const pending = verifier.check();
    await new Promise(resolve => setImmediate(resolve));
    fx.writeGateway({ runtimeOwnerId: 'gateway-b', acquiredAt: '2026-08-08T01:00:30.000Z' });
    resolvePreflight(successfulTest('https://new.example.com'));
    const result = await pending;
    assert.equal(result.stale, true);
    assert.equal(result.verified, false);
    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastPublicHost, 'old.example.com');
  } finally {
    fx.cleanup();
  }
});

test('generation change during persistence cannot be reported as a successful recovery', async () => {
  const fx = fixture();
  let statusCalls = 0;
  try {
    const original = fx.record;
    const later = {
      ...original,
      ownerId: 'owner-b',
      publicUrl: 'https://later.example.com',
      readyAt: '2026-08-08T01:00:30.000Z'
    };
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => {
        assert.equal(port, 8787);
        statusCalls += 1;
        const record = statusCalls >= 3 ? later : original;
        return { running: true, publicUrl: record.publicUrl, record };
      },
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: async input => successfulTest(input.publicUrl)
    });
    const result = await verifier.check();
    assert.equal(result.stale, true);
    assert.equal(result.verified, false);

    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastPublicHost, 'old.example.com');
    assert.equal(config.connection.lastPreflightAt, '2026-08-08T00:00:00.000Z');
  } finally {
    fx.cleanup();
  }
});

test('failed verification is session-generation scoped, persisted, and retried only after backoff', async () => {
  const fx = fixture();
  let now = Date.parse('2026-08-08T01:01:00.000Z');
  let calls = 0;
  let notices = 0;
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      retryMs: 5000,
      now: () => now,
      preflight: async () => {
        calls += 1;
        throw new Error('edge unavailable');
      },
      onError: async () => { notices += 1; }
    });

    const first = await verifier.check();
    assert.equal(first.verified, false);
    assert.equal(calls, 1);
    assert.equal(notices, 1);
    let config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastError, 'edge unavailable');
    assert.equal(config.connection.lastErrorAt, '2026-08-08T01:01:00.000Z');

    const blocked = await verifier.check();
    assert.equal(blocked.reason, 'retry-backoff');
    assert.equal(calls, 1);
    assert.equal(notices, 1);

    now += 5001;
    await verifier.check();
    assert.equal(calls, 2);
    assert.equal(notices, 1, 'the same failing session generation should notify only once');

    fx.record = {
      ...fx.record,
      ownerId: 'owner-b',
      readyAt: '2026-08-08T01:02:00.000Z'
    };
    now = Date.parse('2026-08-08T01:03:00.000Z');
    await verifier.check();
    assert.equal(calls, 3);
    assert.equal(notices, 2, 'a new failing generation may notify again');
  } finally {
    fx.cleanup();
  }
});

test('UI callback failures cannot invalidate a successful public MCP verification', async () => {
  const fx = fixture();
  const logs = [];
  try {
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: async input => successfulTest(input.publicUrl),
      onVerified: async () => { throw new Error('UI unavailable'); },
      logger: message => logs.push(message)
    });
    const result = await verifier.check();
    assert.equal(result.verified, true);
    assert.match(logs.join('\n'), /notification failed after successful verification: UI unavailable/);

    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.equal(config.connection.lastPublicHost, 'new.example.com');
    assert.equal(config.connection.lastError, '');
    assert.equal(config.connection.lastErrorAt, null);
  } finally {
    fx.cleanup();
  }
});

test('already verified current Gateway+tunnel generation performs no duplicate network preflight', async () => {
  const fx = fixture();
  try {
    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      preflight: async input => successfulTest(input.publicUrl)
    });
    const first = await verifier.check({ force: true });
    assert.equal(first.verified, true);
    let calls = 0;
    verifier.preflight = async () => { calls += 1; return successfulTest(fx.record.publicUrl); };
    const result = await verifier.check();
    assert.equal(result.reason, 'already-verified');
    assert.equal(calls, 0);
    const persisted = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    assert.ok(persisted.connection.lastGatewayGeneration);
    assert.ok(persisted.connection.lastTunnelGeneration);
    assert.equal(config.instanceId, persisted.instanceId);
  } finally {
    fx.cleanup();
  }
});

test('authentication-disabled config performs recovery preflight without a bearer token', async () => {
  const fx = fixture();
  try {
    const config = readJson(fx.configFile, null, { strict: true, supportedVersion: true });
    config.auth = { required: false, token: 'must-not-be-sent' };
    atomicWriteJson(fx.configFile, config);
    let observedToken = null;
    const verifier = new PublicTunnelVerifier({
      stateDirectory: fx.stateDirectory,
      tunnelStatus: port => fx.status(port),
      readyGraceMs: 0,
      now: () => Date.parse('2026-08-08T01:01:00.000Z'),
      preflight: async input => {
        observedToken = input.token;
        return successfulTest(input.publicUrl);
      }
    });
    const result = await verifier.check();
    assert.equal(result.verified, true);
    assert.equal(observedToken, '');
  } finally {
    fx.cleanup();
  }
});