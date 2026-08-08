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
      lastServerName: 'devmate'
    }
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
  const testResult = {
    publicOrigin: first.publicUrl,
    toolCount: 25,
    server: { name: 'devmate' }
  };
  const current = {
    connection: successfulVerificationPatch(testResult, first.publicUrl, '2026-08-08T01:00:01.000Z', first)
  };
  assert.equal(current.connection.lastTunnelGeneration, recordGeneration(first));
  assert.equal(verifiedForCurrentRecord(current, first), true);

  const takeover = record('2026-08-08T01:00:00.000Z', { ownerId: 'owner-b' });
  assert.equal(verifiedForCurrentRecord(current, takeover), false);
});

test('matching host alone can never validate malformed or empty MCP evidence', () => {
  const current = record('2026-08-08T01:00:00.000Z');
  for (const connection of [
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 0, lastServerName: 'devmate' },
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/wrong', lastToolCount: 25, lastServerName: 'devmate' },
    { lastPreflightAt: '2026-08-08T01:00:01.000Z', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 25, lastServerName: 'other' },
    { lastPreflightAt: 'not-a-date', lastPublicHost: 'stable.example.com', lastMcpPath: '/mcp', lastToolCount: 25, lastServerName: 'devmate' }
  ]) {
    assert.equal(verifiedForCurrentRecord({ connection }, current), false);
  }
});