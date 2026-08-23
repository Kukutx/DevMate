'use strict';

const { authenticationMode, authenticationPolicyGeneration } = require('./auth-config.cjs');
const { connectionPolicyGeneration } = require('./instance-config.cjs');

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
  const authMode = authenticationMode(config?.auth?.mode);
  const authGeneration = authenticationPolicyGeneration(config);
  const policyGeneration = connectionPolicyGeneration(config);
  if (authMode !== 'oauth' || String(connection.lastAuthMode || '').trim().toLowerCase() !== authMode) return false;
  if (!Number.isSafeInteger(connection.lastAuthGeneration) || connection.lastAuthGeneration !== authGeneration) return false;
  if (!Number.isSafeInteger(connection.lastConnectionPolicyGeneration) || connection.lastConnectionPolicyGeneration !== policyGeneration) return false;
  const preflightAt = Date.parse(connection.lastPreflightAt || '');
  if (!Number.isFinite(preflightAt)) return false;
  const failureAt = Date.parse(connection.lastErrorAt || '');
  if (connection.lastError && Number.isFinite(failureAt) && failureAt >= preflightAt) return false;
  if (notBefore) {
    const minimum = Date.parse(notBefore);
    if (!Number.isFinite(minimum) || preflightAt < minimum) return false;
  }
  if (String(connection.lastServerName || '').toLowerCase() !== 'devmate') return false;
  if (String(connection.lastMcpPath || '') !== '/mcp') return false;
  if (!Number.isInteger(Number(connection.lastToolCount)) || Number(connection.lastToolCount) <= 0) return false;
  if (connection.lastToolCallVerified !== true) return false;
  if (String(connection.lastProbeTool || '') !== 'gateway_status') return false;
  const publicHost = hostOf(publicUrl);
  const verifiedHost = String(connection.lastPublicHost || '').trim().toLowerCase();
  return !!publicHost && verifiedHost === publicHost;
}

function verifiedForCurrentRecord(config, record, gatewayLock = null) {
  const tunnelGeneration = recordGeneration(record);
  if (!tunnelGeneration) return false;
  if (!runtimeMatchesConnection(config, record).matches) return false;
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
  gatewayLock = null,
  authMode = 'oauth',
  authGeneration = 0,
  policyGeneration = 0
) {
  const tunnelGeneration = recordGeneration(record);
  const currentGatewayGeneration = gatewayGeneration(gatewayLock) || String(record?.gatewayGeneration || '').trim();
  const normalizedAuthGeneration = Number(authGeneration);
  const normalizedPolicyGeneration = Number(policyGeneration);
  if (!Number.isSafeInteger(normalizedAuthGeneration) || normalizedAuthGeneration < 0) {
    throw new Error(`Invalid authentication generation for public verification evidence: ${String(authGeneration)}`);
  }
  if (!Number.isSafeInteger(normalizedPolicyGeneration) || normalizedPolicyGeneration < 0) {
    throw new Error(`Invalid connection policy generation for public verification evidence: ${String(policyGeneration)}`);
  }
  return {
    lastPreflightAt: stamp,
    lastAuthMode: authenticationMode(authMode),
    lastAuthGeneration: normalizedAuthGeneration,
    lastConnectionPolicyGeneration: normalizedPolicyGeneration,
    lastPublicOrigin: String(test?.publicOrigin || publicUrl || '').trim(),
    lastPublicHost: hostOf(test?.publicOrigin || publicUrl),
    lastMcpPath: '/mcp',
    lastToolCount: Number(test?.toolCount || 0),
    lastToolCallVerified: test?.toolCallVerified === true,
    lastProbeTool: String(test?.probeTool || ''),
    lastServerName: String(test?.server?.name || 'devmate'),
    lastServerVersion: String(test?.server?.version || ''),
    ...(tunnelGeneration ? { lastTunnelGeneration: tunnelGeneration } : {}),
    ...(currentGatewayGeneration ? { lastGatewayGeneration: currentGatewayGeneration } : {}),
    lastError: '',
    lastErrorCode: '',
    lastErrorKind: '',
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
