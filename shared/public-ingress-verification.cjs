'use strict';

function cleanHttpsOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname && url.pathname !== '/')
    ) return '';
    return `https://${url.host}`;
  } catch {
    return '';
  }
}

function hostOf(value) {
  try { return new URL(String(value || '')).host.toLowerCase(); }
  catch { return ''; }
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function gatewayGeneration(lock) {
  if (
    !lock ||
    !lock.runtimeOwnerId ||
    !lock.acquiredAt ||
    !lock.instanceId ||
    !processAlive(lock.pid)
  ) return '';
  return [
    String(lock.runtimeOwnerId),
    String(lock.pid),
    String(lock.instanceId),
    String(lock.acquiredAt)
  ].join('|');
}

function recordGeneration(record) {
  if (!record || record.status !== 'ready' || !record.publicUrl || !record.readyAt) return '';
  const hasGatewayGeneration = Object.hasOwn(record, 'gatewayGeneration');
  if (hasGatewayGeneration && !String(record.gatewayGeneration || '').trim()) return '';
  return [
    String(record.ownerId || ''),
    String(record.provider || ''),
    String(record.port || ''),
    String(record.readyAt || ''),
    String(record.publicUrl || ''),
    ...(hasGatewayGeneration ? [String(record.gatewayGeneration)] : [])
  ].join('|');
}

function sessionGeneration(record, gatewayLock) {
  const tunnel = recordGeneration(record);
  if (!tunnel) return '';
  const boundGateway = String(record?.gatewayGeneration || '').trim();
  const liveGateway = gatewayGeneration(gatewayLock);
  if (boundGateway && liveGateway && boundGateway !== liveGateway) return '';
  const gateway = liveGateway || boundGateway;
  if (!gateway) return '';
  return boundGateway ? tunnel : `${tunnel}::${gateway}`;
}

function runtimeMatchesConnection(config, record, publicUrl = cleanHttpsOrigin(record?.publicUrl || '')) {
  const desiredProvider = String(config?.connection?.provider || '').trim().toLowerCase();
  const actualProvider = String(record?.provider || '').trim().toLowerCase();
  if (desiredProvider && actualProvider !== desiredProvider) {
    return {
      matches: false,
      reason: `shared tunnel provider ${actualProvider || 'unknown'} does not match configured provider ${desiredProvider}`
    };
  }

  const configuredUrl = cleanHttpsOrigin(config?.connection?.publicUrl || '');
  if (configuredUrl && publicUrl !== configuredUrl) {
    return {
      matches: false,
      reason: `shared tunnel URL ${publicUrl || 'unavailable'} does not match configured stable URL ${configuredUrl}`
    };
  }
  return { matches: true, reason: '' };
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

function verifiedForCurrentRecord(config, record, gatewayLock = null) {
  const tunnelGeneration = recordGeneration(record);
  if (!tunnelGeneration) return false;
  const persistedTunnelGeneration = String(config?.connection?.lastTunnelGeneration || '').trim();
  if (persistedTunnelGeneration && persistedTunnelGeneration !== tunnelGeneration) return false;

  const persistedGatewayGeneration = String(config?.connection?.lastGatewayGeneration || '').trim();
  if (persistedGatewayGeneration) {
    const currentGatewayGeneration = gatewayGeneration(gatewayLock) || String(record?.gatewayGeneration || '').trim();
    if (!currentGatewayGeneration || persistedGatewayGeneration !== currentGatewayGeneration) return false;
  }

  return verifiedConnection(config, record.publicUrl, { notBefore: record.readyAt });
}

function successfulVerificationPatch(
  test,
  publicUrl,
  stamp = new Date().toISOString(),
  record = null,
  gatewayLock = null
) {
  const tunnelGeneration = recordGeneration(record);
  const currentGatewayGeneration = gatewayGeneration(gatewayLock) || String(record?.gatewayGeneration || '').trim();
  return {
    lastPreflightAt: stamp,
    lastPublicOrigin: String(test?.publicOrigin || publicUrl || '').trim(),
    lastPublicHost: hostOf(test?.publicOrigin || publicUrl),
    lastMcpPath: '/mcp',
    lastToolCount: Number(test?.toolCount || 0),
    lastServerName: String(test?.server?.name || 'devmate'),
    ...(tunnelGeneration ? { lastTunnelGeneration: tunnelGeneration } : {}),
    ...(currentGatewayGeneration ? { lastGatewayGeneration: currentGatewayGeneration } : {}),
    lastError: '',
    lastErrorAt: null
  };
}

module.exports = {
  cleanHttpsOrigin,
  gatewayGeneration,
  hostOf,
  processAlive,
  recordGeneration,
  runtimeMatchesConnection,
  sessionGeneration,
  successfulVerificationPatch,
  verifiedConnection,
  verifiedForCurrentRecord
};