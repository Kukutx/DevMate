'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { configureAuthentication } = require('../shared/auth-config.cjs');
const { setConnectionPolicy } = require('../shared/instance-config.cjs');
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
    hostRuntime: { authenticationPolicyGeneration: 0 },
    auth: { mode: 'oauth' },
    connection: {
      provider: 'ngrok',
      publicUrl: 'https://stable.example.com',
      policyGeneration: 0,
      lastPreflightAt: preflightAt,
      lastAuthMode: 'oauth',
      lastAuthGeneration: 0,
      lastConnectionPolicyGeneration: 0,
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

function freshEvidence(current, currentRecord, stamp, authGeneration, policyGeneration) {
  current.connection = {
    ...current.connection,
    ...successfulVerificationPatch(
      verifiedTestResult(currentRecord.publicUrl),
      currentRecord.publicUrl,
      stamp,
      currentRecord,
      null,
      'oauth',
      authGeneration,
      policyGeneration
    )
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

test('new verification evidence binds to tunnel, authentication and connection policy generations', () => {
  const first = record('2026-08-08T01:00:00.000Z');
  const current = config();
  freshEvidence(current, first, '2026-08-08T01:00:01.000Z', 0, 0);
  assert.equal(current.connection.lastTunnelGeneration, recordGeneration(first));
  assert.equal(current.connection.lastAuthMode, 'oauth');
  assert.equal(current.connection.lastAuthGeneration, 0);
  assert.equal(current.connection.lastConnectionPolicyGeneration, 0);
  assert.equal(current.connection.lastToolCallVerified, true);
  assert.equal(current.connection.lastProbeTool, 'gateway_status');
  assert.equal(verifiedForCurrentRecord(current, first), true);

  const takeover = record('2026-08-08T01:00:00.000Z', { ownerId: 'owner-b' });
  assert.equal(verifiedForCurrentRecord(current, takeover), false);
});

test('authentication changes invalidate evidence even after OAuth-none-OAuth ABA', () => {
  const currentRecord = record('2026-08-08T01:00:00.000Z');
  const current = config();
  assert.equal(verifiedForCurrentRecord(current, currentRecord), true);

  configureAuthentication(current, 'none', { replace: true });
  assert.equal(current.hostRuntime.authenticationPolicyGeneration, 1);
  assert.equal(verifiedForCurrentRecord(current, currentRecord), false);

  configureAuthentication(current, 'oauth', { replace: true });
  assert.equal(current.hostRuntime.authenticationPolicyGeneration, 2);
  assert.equal(current.auth.mode, 'oauth');
  assert.equal(current.connection.lastAuthMode, 'oauth');
  assert.equal(verifiedForCurrentRecord(current, currentRecord), false, 'old OAuth evidence survived an auth-policy ABA transition');

  freshEvidence(current, currentRecord, '2026-08-08T01:00:02.000Z', current.hostRuntime.authenticationPolicyGeneration, current.connection.policyGeneration);
  assert.equal(verifiedForCurrentRecord(current, currentRecord), true);
});

test('connection policy changes invalidate evidence even after provider-URL ABA', () => {
  const currentRecord = record('2026-08-08T01:00:00.000Z');
  const current = config();
  assert.equal(verifiedForCurrentRecord(current, currentRecord), true);

  setConnectionPolicy(current, { provider: 'external', publicUrl: 'https://other.example.com' });
  assert.equal(current.connection.policyGeneration, 1);
  assert.equal(verifiedForCurrentRecord(current, currentRecord), false);

  setConnectionPolicy(current, { provider: 'ngrok', publicUrl: currentRecord.publicUrl });
  assert.equal(current.connection.policyGeneration, 2);
  assert.equal(current.connection.provider, 'ngrok');
  assert.equal(current.connection.publicUrl, currentRecord.publicUrl);
  assert.equal(verifiedForCurrentRecord(current, currentRecord), false, 'old Ready evidence survived a connection-policy ABA transition');

  freshEvidence(current, currentRecord, '2026-08-08T01:00:02.000Z', current.hostRuntime.authenticationPolicyGeneration, current.connection.policyGeneration);
  assert.equal(verifiedForCurrentRecord(current, currentRecord), true);
});

test('a ready tunnel that does not match the configured provider or stable URL is never Ready', () => {
  const currentRecord = record('2026-08-08T01:00:00.000Z');
  const wrongProvider = config();
  wrongProvider.connection.provider = 'external';
  assert.equal(verifiedForCurrentRecord(wrongProvider, currentRecord), false);

  const wrongUrl = config();
  wrongUrl.connection.publicUrl = 'https://different.example.com';
  assert.equal(verifiedForCurrentRecord(wrongUrl, currentRecord), false);
});

test('same tunnel process requires a fresh preflight when Gateway generation changes', () => {
  const first = record('2026-08-08T01:00:00.000Z', { gatewayGeneration: 'gateway-a' });
  const current = config();
  freshEvidence(current, first, '2026-08-08T01:00:01.000Z', 0, 0);
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
  const base = {
    provider: 'ngrok', publicUrl: 'https://stable.example.com', policyGeneration: 0,
    lastAuthMode: 'oauth', lastAuthGeneration: 0, lastConnectionPolicyGeneration: 0,
    lastPublicHost: 'stable.example.com', lastToolCallVerified: true, lastProbeTool: 'gateway_status', lastServerName: 'devmate'
  };
  for (const connection of [
    { ...base, lastPreflightAt: '2026-08-08T01:00:01.000Z', lastMcpPath: '/mcp', lastToolCount: 0 },
    { ...base, lastPreflightAt: '2026-08-08T01:00:01.000Z', lastMcpPath: '/wrong', lastToolCount: 25 },
    { ...base, lastPreflightAt: '2026-08-08T01:00:01.000Z', lastMcpPath: '/mcp', lastToolCount: 25, lastServerName: 'other' },
    { ...base, lastPreflightAt: '2026-08-08T01:00:01.000Z', lastMcpPath: '/mcp', lastToolCount: 25, lastToolCallVerified: false },
    { ...base, lastPreflightAt: '2026-08-08T01:00:01.000Z', lastMcpPath: '/mcp', lastToolCount: 25, lastProbeTool: 'wrong' },
    { ...base, lastPreflightAt: 'not-a-date', lastMcpPath: '/mcp', lastToolCount: 25 }
  ]) {
    assert.equal(verifiedForCurrentRecord({ hostRuntime: { authenticationPolicyGeneration: 0 }, auth: { mode: 'oauth' }, connection }, current), false);
  }
});
