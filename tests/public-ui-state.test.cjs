'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  connectionProvider,
  currentFailure,
  publicUiState,
  statusLabel
} = require('../vscode-host/public-ui-state.js');

function config(overrides = {}) {
  return {
    connection: { provider: 'cloudflare-quick', publicUrl: '', policyGeneration: 0, ...(overrides.connection || {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'connection'))
  };
}

function readyRecord(overrides = {}) {
  return {
    ownerId: 'owner-a',
    provider: 'cloudflare-quick',
    port: 8787,
    status: 'ready',
    publicUrl: 'https://current.example.com',
    readyAt: '2026-08-08T01:00:00.000Z',
    ...overrides
  };
}

function verifiedConfig() {
  return config({
    auth: { mode: 'oauth' },
    hostRuntime: { authenticationPolicyGeneration: 0 },
    connection: {
      lastPreflightAt: '2026-08-08T01:00:01.000Z',
      lastAuthMode: 'oauth',
      lastAuthGeneration: 0,
      lastConnectionPolicyGeneration: 0,
      lastPublicHost: 'current.example.com',
      lastMcpPath: '/mcp',
      lastToolCount: 12,
      lastToolCallVerified: true,
      lastProbeTool: 'gateway_status',
      lastServerName: 'devmate',
      lastError: '',
      lastErrorAt: null
    }
  });
}

test('shared connection provider is the UI provider source of truth', () => {
  assert.equal(connectionProvider(config(), 'ngrok'), 'cloudflare-quick');
  assert.throws(() => connectionProvider(config({ connection: { provider: 'automatic' } })), /Unknown connection provider/);
});

test('only the current tool-call-verified generation is presented as ready', () => {
  const record = readyRecord();
  const state = publicUiState(verifiedConfig(), { running: true, publicUrl: record.publicUrl, record });
  assert.equal(state.state, 'verified');
  assert.equal(state.verified, true);
  assert.equal(state.publicUrl, 'https://current.example.com');
  assert.equal(state.stability.kind, 'temporary');
  assert.equal(state.stability.chatgptEligible, false);
  assert.equal(statusLabel(state), 'DevMate: ready');
});

test('handshake-only evidence never produces the ready UI state', () => {
  const record = readyRecord();
  const handshakeOnly = verifiedConfig();
  delete handshakeOnly.connection.lastToolCallVerified;
  delete handshakeOnly.connection.lastProbeTool;
  const state = publicUiState(handshakeOnly, { running: true, publicUrl: record.publicUrl, record });
  assert.equal(state.state, 'unverified');
  assert.equal(state.verified, false);
  assert.equal(statusLabel(state), 'DevMate: public check pending');
});

test('a newly ready generation is pending until it has its own preflight evidence', () => {
  const record = readyRecord({ readyAt: '2026-08-08T01:02:00.000Z' });
  const state = publicUiState(verifiedConfig(), { running: true, publicUrl: record.publicUrl, record });
  assert.equal(state.state, 'unverified');
  assert.equal(state.verified, false);
  assert.equal(statusLabel(state), 'DevMate: public check pending');
});

test('only errors recorded after the current readyAt mark that generation as failed', () => {
  const record = readyRecord();
  const stale = config({ connection: { lastError: 'old failure', lastErrorAt: '2026-08-08T00:59:59.000Z' } });
  assert.equal(currentFailure(stale, record), '');
  assert.equal(publicUiState(stale, { running: true, publicUrl: record.publicUrl, record }).state, 'unverified');

  const current = config({ connection: { lastError: 'current failure', lastErrorAt: '2026-08-08T01:00:01.000Z' } });
  const failed = publicUiState(current, { running: true, publicUrl: record.publicUrl, record });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure, 'current failure');
  assert.equal(statusLabel(failed), 'DevMate: public check failed');

  const recoveringConfig = config({ connection: {
    lastError: 'timeout',
    lastErrorAt: '2026-08-08T01:00:02.000Z',
    lastErrorCode: 'ETIMEDOUT',
    lastErrorKind: 'temporary-network'
  } });
  const recovering = publicUiState(recoveringConfig, { running: true, publicUrl: record.publicUrl, record });
  assert.equal(recovering.state, 'recovering');
  assert.equal(recovering.failureCode, 'ETIMEDOUT');
  assert.equal(statusLabel(recovering), 'DevMate: reconnecting');
});

test('provider pending and absent states never expose a stale public URL', () => {
  const pendingRecord = { ownerId: 'owner-a', provider: 'ngrok', port: 8787, status: 'pending', publicUrl: '' };
  const pending = publicUiState(config({ connection: { provider: 'ngrok' } }), {
    running: true, provider: 'ngrok', publicUrl: '', record: pendingRecord
  });
  assert.equal(pending.state, 'pending');
  assert.equal(pending.publicUrl, '');
  assert.equal(statusLabel(pending), 'DevMate: tunnel starting');

  const absent = publicUiState(config(), { running: false, publicUrl: '', record: null });
  assert.equal(absent.state, 'absent');
  assert.equal(absent.publicUrl, '');
  assert.equal(statusLabel(absent, { state: 'running', port: 8787 }), 'DevMate: gateway :8787');
});
