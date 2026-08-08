'use strict';

function hostOf(value) {
  try { return new URL(String(value || '')).host.toLowerCase(); }
  catch { return ''; }
}

function recordGeneration(record) {
  if (!record || record.status !== 'ready' || !record.publicUrl || !record.readyAt) return '';
  return [
    String(record.ownerId || ''),
    String(record.provider || ''),
    String(record.port || ''),
    String(record.readyAt || ''),
    String(record.publicUrl || '')
  ].join('|');
}

function verifiedConnection(config, publicUrl, { notBefore = '' } = {}) {
  const connection = config?.connection || {};
  const preflightAt = Date.parse(connection.lastPreflightAt || '');
  if (!Number.isFinite(preflightAt)) return false;
  if (notBefore) {
    const minimum = Date.parse(notBefore);
    if (!Number.isFinite(minimum) || preflightAt < minimum) return false;
  }
  if (String(connection.lastServerName || '').toLowerCase() !== 'devmate') return false;
  if (String(connection.lastMcpPath || '') !== '/mcp') return false;
  if (!Number.isInteger(Number(connection.lastToolCount)) || Number(connection.lastToolCount) <= 0) return false;
  const publicHost = hostOf(publicUrl);
  const verifiedHost = String(connection.lastPublicHost || '').trim().toLowerCase();
  return !!publicHost && verifiedHost === publicHost;
}

function verifiedForCurrentRecord(config, record) {
  return !!recordGeneration(record) && verifiedConnection(config, record.publicUrl, { notBefore: record.readyAt });
}

function successfulVerificationPatch(test, publicUrl, stamp = new Date().toISOString()) {
  return {
    lastPreflightAt: stamp,
    lastPublicOrigin: String(test?.publicOrigin || publicUrl || '').trim(),
    lastPublicHost: hostOf(test?.publicOrigin || publicUrl),
    lastMcpPath: '/mcp',
    lastToolCount: Number(test?.toolCount || 0),
    lastServerName: String(test?.server?.name || 'devmate'),
    lastError: '',
    lastErrorAt: null
  };
}

module.exports = {
  hostOf,
  recordGeneration,
  successfulVerificationPatch,
  verifiedConnection,
  verifiedForCurrentRecord
};
