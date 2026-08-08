'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  currentFailure,
  deploymentProvider,
  publicUiState,
  statusLabel
} = require('../vscode-host/public-ui-state.js');

function config(overrides = {}) {
  return {
    connection: { provider: 'cloudflare-quick', publicUrl: '', ...(overrides.connection || {}) },
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
    connection: {
      lastPreflightAt: '2026-08-08T01:00:01.000Z',
      lastPublicHost: 'current.example.com',
      lastMcpPath: '/mcp',
      lastToolCount: 12,
      lastServerName: 'devmate',
      lastError: '',
      lastErrorAt: null
    }
  });
}

test('shared connection provider is the UI provider source of truth', () => {
  assert.equal(deploymentProvider(config(), 'ngrok'), 'cloudflare-quick');
  assert.throws(() => deploymentProvider(config({ connection: { provider: 'automatic' } })), /Unknown connection provider/);
});

test('only the current verified generation is presented as ready', () => {
  const record = readyRecord();
  const state = publicUiState(verifiedConfig(), { running: true, publicUrl: record.publicUrl, record });
  assert.equal(state.state, 'verified');
  assert.equal(state.verified, true);
  assert.equal(state.publicUrl, 'https://current.example.com');
  assert.equal(statusLabel(state), 'DevMate: ready');
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
