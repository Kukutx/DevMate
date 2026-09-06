'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_VERSION, newInstanceConfig } = require('../shared/config-store.cjs');
const {
  successfulVerificationPatch
} = require('../shared/public-ingress-verification.cjs');
const {
  reconcileRecoveredStartup,
  reconcileRuntimeStartup
} = require('../vscode-host/runtime-diagnostics.js');

function fixture({
  failedAt = '2026-09-06T22:23:36.596Z',
  verifiedAt = '2026-09-06T22:24:00.708Z'
} = {}) {
  const record = {
    version: 1,
    ownerId: 'vscode-test-tunnel',
    hostId: 'vscode-test',
    port: 8787,
    provider: 'ngrok',
    status: 'ready',
    publicUrl: 'https://recovered.example.test',
    readyAt: '2026-09-06T22:22:45.985Z',
    gatewayGeneration: 'gateway-owner|1234|instance-a|2026-09-06T22:22:45.141Z'
  };
  const config = newInstanceConfig({
    workspaceRoot: process.cwd(),
    port: 8787,
    appVersion: DEFAULT_VERSION,
    defaultConnectionProvider: 'ngrok'
  });
  config.auth = { mode: 'none' };
  config.lifecycle = {
    desiredState: 'running',
    generation: 1,
    updatedAt: '2026-09-06T22:22:43.000Z',
    requestedBy: 'test',
    reason: 'diagnostics recovery test'
  };
  Object.assign(config.connection, successfulVerificationPatch(
    {
      publicOrigin: record.publicUrl,
      mcpUrl: `${record.publicUrl}/mcp`,
      toolCount: 182,
      toolCallVerified: true,
      probeTool: 'gateway_status',
      server: { name: 'devmate', version: DEFAULT_VERSION }
    },
    record.publicUrl,
    verifiedAt,
    record,
    null,
    'none',
    0,
    0
  ));
  const startup = {
    startedAt: '2026-09-06T22:22:43.914Z',
    totalMs: 52682,
    success: false,
    stages: { gatewayMs: 1683, tunnelMs: 400 },
    failedAt,
    errorCode: 'DEVMATE_PUBLIC_MCP_TOOLS_FAILED',
    error: 'MCP tools/list failed: timeout'
  };
  return { config, record, startup };
}

test('verified current-generation evidence reconciles a failed startup as recovered without erasing failure history', () => {
  const { config, record, startup } = fixture();
  const result = reconcileRecoveredStartup(startup, config, record);

  assert.notEqual(result, startup);
  assert.equal(result.success, true);
  assert.equal(result.outcome, 'recovered');
  assert.equal(result.recovered, true);
  assert.deepEqual(result.recovery, {
    verifiedAt: '2026-09-06T22:24:00.708Z',
    toolCount: 182,
    tunnelGeneration: config.connection.lastTunnelGeneration,
    gatewayGeneration: config.connection.lastGatewayGeneration
  });
  assert.deepEqual(result.initialFailure, {
    failedAt: '2026-09-06T22:23:36.596Z',
    errorCode: 'DEVMATE_PUBLIC_MCP_TOOLS_FAILED',
    error: 'MCP tools/list failed: timeout'
  });
  assert.equal(Object.hasOwn(result, 'failedAt'), false);
  assert.equal(Object.hasOwn(result, 'errorCode'), false);
  assert.equal(Object.hasOwn(result, 'error'), false);

  assert.equal(startup.success, false, 'reconciliation must not mutate the raw attempt trace');
  assert.equal(startup.failedAt, '2026-09-06T22:23:36.596Z');
});

test('verification evidence older than the failed attempt cannot rewrite startup history', () => {
  const { config, record, startup } = fixture({
    verifiedAt: '2026-09-06T22:23:00.000Z'
  });
  const result = reconcileRecoveredStartup(startup, config, record);
  assert.equal(result, startup);
  assert.equal(result.success, false);
});

test('verification for a different tunnel generation cannot reconcile startup', () => {
  const { config, record, startup } = fixture();
  config.connection.lastTunnelGeneration = 'stale-tunnel-generation';
  const result = reconcileRecoveredStartup(startup, config, record);
  assert.equal(result, startup);
  assert.equal(result.success, false);
});

test('a stopped lifecycle cannot be reported as recovered even with old verified evidence', () => {
  const { config, record, startup } = fixture();
  config.lifecycle.desiredState = 'stopped';
  const result = reconcileRecoveredStartup(startup, config, record);
  assert.equal(result, startup);
  assert.equal(result.success, false);
});

test('a later verification failure invalidates recovery reconciliation', () => {
  const { config, record, startup } = fixture();
  config.connection.lastError = 'public endpoint timed out again';
  config.connection.lastErrorCode = 'DEVMATE_PUBLIC_MCP_TOOLS_FAILED';
  config.connection.lastErrorKind = 'temporary-network';
  config.connection.lastErrorAt = '2026-09-06T22:24:05.000Z';
  const result = reconcileRecoveredStartup(startup, config, record);
  assert.equal(result, startup);
  assert.equal(result.success, false);
});

test('runtime reconciliation uses the shared current tunnel record and leaves unrelated runtime state untouched', () => {
  const { config, record, startup } = fixture();
  const runtime = {
    platform: { startup, gateway: { phase: 'running' } },
    shared: { tunnel: { running: true, record }, sessionRecovery: { requested: true } }
  };
  const result = reconcileRuntimeStartup(runtime, config);

  assert.notEqual(result, runtime);
  assert.equal(result.platform.startup.outcome, 'recovered');
  assert.deepEqual(result.platform.gateway, runtime.platform.gateway);
  assert.deepEqual(result.shared, runtime.shared);
  assert.equal(runtime.platform.startup.success, false);
});
