'use strict';

const { verifiedForCurrentRecord } = require('../shared/public-ingress-verification.cjs');
const { tunnelProvider: validateTunnelProvider } = require('./tunnel-settings.js');

function connectionProvider(config, fallback = 'ngrok') {
  const value = config?.connection?.provider;
  return validateTunnelProvider(String(value === undefined ? fallback : value).trim().toLowerCase());
}

function currentFailure(config, record) {
  if (!record?.readyAt || !config?.connection?.lastErrorAt || !config?.connection?.lastError) return '';
  const readyAt = Date.parse(record.readyAt);
  const errorAt = Date.parse(config.connection.lastErrorAt);
  if (!Number.isFinite(readyAt) || !Number.isFinite(errorAt) || errorAt < readyAt) return '';
  return String(config.connection.lastError || '');
}

function publicUiState(config, tunnelStatus = null, { runtimeError = '', gatewayLock = null } = {}) {
  const provider = connectionProvider(config);
  const record = tunnelStatus?.record || null;
  const publicUrl = String(record?.publicUrl || tunnelStatus?.publicUrl || '').trim();
  const verified = !!record && verifiedForCurrentRecord(config, record, gatewayLock);
  const failure = currentFailure(config, record);

  if (verified) {
    return { state: 'verified', provider: record.provider || provider, publicUrl, verified: true, failure: '', record, tunnel: tunnelStatus };
  }
  if (record?.status === 'ready' && publicUrl && failure) {
    return { state: 'failed', provider: record.provider || provider, publicUrl, verified: false, failure, record, tunnel: tunnelStatus };
  }
  if (record?.status === 'ready' && publicUrl) {
    return { state: 'unverified', provider: record.provider || provider, publicUrl, verified: false, failure: '', record, tunnel: tunnelStatus };
  }
  if (record?.status === 'pending' || tunnelStatus?.running) {
    return { state: 'pending', provider: record?.provider || tunnelStatus?.provider || provider, publicUrl: '', verified: false, failure: '', record, tunnel: tunnelStatus };
  }
  return {
    state: runtimeError ? 'unavailable' : 'absent',
    provider,
    publicUrl: '',
    verified: false,
    failure: runtimeError ? String(runtimeError) : '',
    record,
    tunnel: tunnelStatus
  };
}

function statusLabel(state, gateway = null) {
  if (state?.state === 'verified') return 'DevMate: ready';
  if (state?.state === 'failed') return 'DevMate: public check failed';
  if (state?.state === 'unverified') return 'DevMate: public check pending';
  if (state?.state === 'pending') return 'DevMate: tunnel starting';
  if (gateway?.state === 'running') return `DevMate: gateway :${gateway.port}`;
  if (gateway?.state === 'starting' || gateway?.state === 'stopping') return `DevMate: ${gateway.state}`;
  return 'DevMate: stopped';
}

module.exports = { connectionProvider, currentFailure, publicUiState, statusLabel };
