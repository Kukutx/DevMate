'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  recordGeneration,
  successfulVerificationPatch,
  verifiedForCurrentRecord
} = require('../shared/public-ingress-verification.cjs');

function record(readyAt, overrides = {}) {
  return {
    ownerId: 'owner-a',
    provider: 'ngrok',
    port: 8787,
    status: 'ready',
    publicUrl: 'https://stable.example.com',
    readyAt,
    ...overrides
  };
}

function config(preflightAt = '2026-08-08T01:00:01.000Z') {
  return {
    connection: {
      lastPreflightAt: preflightAt,
      lastPublicHost: 'stable.example.com',
      lastMcpPath: '/mcp',
      lastToolCount: 25,
      lastToolCallVerified: true,
      lastProbeTool: 'gateway_status',
      lastServerName: 'devmate'
    }
  };
}

function verifiedTestResult(publicUrl) {
  return {
    publicOrigin: publicUrl,
    toolCount: 25,
    toolCallVerified: true,
    probeTool: 'gateway_status',
    server: { name: 'devmate' }
  };
}

test('same stable hostname still requires a fresh preflight after provider process generation changes', () => {
  const first = record('2026-08-08T01:00:00.000Z');
  assert.equal(verifiedForCurrentRecord(config(), first), true);

  const restarted = record('2026-08-08T01:05:00.000Z');
  assert.equal(restarted.publicUrl, first.publicUrl);
  assert.equal(verifiedForCurrentRecord(config(), restarted), false);
  assert.notEqual(recordGeneration(first), recordGeneration(restarted));
});

test('ownership takeover creates a distinct generation even when URL and ready time are otherwise equal', () => {
  const first = record('2026-08-08T01:00:00.000Z');
  const takeover = record('2026-08-08T01:00:00.000Z', { ownerId: 'owner-b' });
  assert.notEqual(recordGeneration(first), recordGeneration(takeover));
});

test('new verification evidence binds to the exact tunnel generation', () => {
  const first = record('2026-08-08T01:00:00.000Z');
  const current = {
    connection: successfulVerificationPatch(verifiedTestResult(first.publicUrl), first.publicUrl, '2026-08-08T01:00:01.000Z', first)
  };
  assert.equal(current.connection.lastTunnelGeneration, recordGeneration(first));
  assert.equal(current.connection.lastToolCallVerified, true);
  assert.equal(current.connection.lastProbeTool, 'gateway_status');
  assert.equal(verifiedForCurrentRecord(current, first), true);

  const takeover = record('2026-08-08T01:00:00.000Z', { ownerId: 'owner-b' });
  assert.equal(verifiedForCurrentRecord(current, takeover), false);
});

test('same tunnel process requires a fresh preflight when Gateway generation changes', () => {
  const first = record('2026-08-08T01:00:00.000Z', { gatewayGeneration: 'gateway-a' });
  const current = {
    connection: successfulVerificationPatch(verifiedTestResult(first.publicUrl), first.publicUrl, '2026-08-08T01:00:01.000Z', first)
  };
  assert.equal(current.connection.lastGatewayGeneration, 'gateway-a');
  assert.equal(current.connection.lastTunnelGeneration, recordGeneration(first));
  assert.equal(verifiedForCurrentRecord(current, first), true);

  const restartedGateway = { ...first, gatewayGeneration: 'gateway-b' };
  assert.notEqual(recordGeneration(restartedGateway), recordGeneration(first));
  assert.equal(verifiedForCurrentRecord(current, restartedGateway), false);
});

test('runtime-enriched ready tunnel is never a valid generation when no live Gateway exists', () => {
  const missingGateway = record('2026-08-08T01:00:00.000Z', { gatewayGeneration: '' });
  assert.equal(recordGeneration(missingGateway), '');
  assert.equal(verifiedForCurrentRecord(config(), missingGateway), false);
});

test('handshake-only evidence is invalid until a real MCP tool call succeeds', () => {
  const current = record('2026-08-08T01:00:00.000Z');
  const handshakeOnly = config();
  delete handshakeOnly.connection.lastToolCallVerified;
  delete handshakeOnly.connection.lastProbeTool;
  assert.equal(verifiedForCurrentRecord(handshakeOnly, current), false);

  const wrongProbe = config();
  wrongProbe.connection.lastProbeTool = 'tools/list';
  assert.equal(verifiedForCurrentRecord(wrongProbe, current), false);
});

test('matching host alone can never validate malformed or empty MCP evidence', () => {
  const current = record('2026-08-08T01:00:00.000Z');
  for (const connection of [
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 0, lastToolCallVerified: true, lastProbeTool: 'gateway_status', lastServerName: 'devmate' },
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/wrong', lastToolCount: 25, lastToolCallVerified: true, lastProbeTool: 'gateway_status', lastServerName: 'devmate' },
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 25, lastToolCallVerified: true, lastProbeTool: 'gateway_status', lastServerName: 'other' },
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 25, lastToolCallVerified: false, lastProbeTool: 'gateway_status', lastServerName: 'devmate' },
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 25, lastToolCallVerified: true, lastProbeTool: 'wrong', lastServerName: 'devmate' },
    { lastPreflightAt: 'not-a-date', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 25, lastToolCallVerified: true, lastProbeTool: 'gateway_status', lastServerName: 'devmate' }
  ]) {
    assert.equal(verifiedForCurrentRecord({ connection }, current), false);
  }
});
