import path from 'node:path';
import verification from '../shared/public-ingress-verification.cjs';
import tunnelRecordStore from '../vscode-host/shared-tunnel-record-store.js';
import { CONFIG_PATH } from './local-shared.mjs';

const {
  cleanHttpsOrigin,
  runtimeMatchesConnection,
  verifiedConnection,
  verifiedForCurrentRecord
} = verification;
const { SharedTunnelRecordStore } = tunnelRecordStore;

export function runtimePublicIngress(config, { stateDirectory } = {}) {
  const directory = stateDirectory || (CONFIG_PATH ? path.dirname(CONFIG_PATH) : '');
  if (!directory) {
    return { available: false, verified: false, source: 'runtime', reason: 'shared state directory unavailable' };
  }
  try {
    const record = new SharedTunnelRecordStore({ stateDirectory: directory }).read();
    if (!record || record.status !== 'ready' || !record.publicUrl) {
      return { available: false, verified: false, source: 'runtime', reason: 'no ready shared tunnel' };
    }
    const publicUrl = cleanHttpsOrigin(record.publicUrl);
    if (!publicUrl) {
      return { available: false, verified: false, source: 'runtime', reason: 'shared tunnel URL is not a clean HTTPS origin' };
    }
    const connectionMatch = runtimeMatchesConnection(config, record, publicUrl);
    if (!connectionMatch.matches) {
      return {
        available: false,
        verified: false,
        source: 'runtime',
        publicUrl: '',
        provider: record.provider,
        hostId: record.hostId || '',
        readyAt: record.readyAt || null,
        reason: connectionMatch.reason,
        stale: true
      };
    }
    const verified = verifiedForCurrentRecord(config, record);
    return {
      available: true,
      verified,
      source: 'runtime',
      publicUrl,
      provider: record.provider,
      hostId: record.hostId || '',
      readyAt: record.readyAt || null,
      reason: verified ? 'current shared tunnel passed MCP preflight' : 'shared tunnel has not passed MCP preflight since its current ready state'
    };
  } catch (error) {
    return {
      available: false,
      verified: false,
      source: 'runtime',
      reason: `shared tunnel state unavailable: ${error.message || error}`,
      errorCode: error?.code || null
    };
  }
}

export function effectivePublicIngress(config, options = {}) {
  const runtime = runtimePublicIngress(config, options);
  if (runtime.available && runtime.verified) return runtime;

  const configured = cleanHttpsOrigin(config?.connection?.publicUrl || '');
  if (configured) {
    const verified = verifiedConnection(config, configured);
    return {
      available: verified,
      verified,
      source: 'configured',
      publicUrl: configured,
      provider: config?.connection?.provider || null,
      runtime,
      reason: verified
        ? 'configured HTTPS origin passed MCP preflight'
        : 'configured HTTPS origin has not passed MCP preflight'
    };
  }

  if (runtime.available) {
    return {
      ...runtime,
      available: false,
      reason: runtime.reason || 'current public connection has not passed MCP preflight'
    };
  }

  return {
    available: false,
    verified: false,
    source: 'none',
    publicUrl: '',
    provider: config?.connection?.provider || null,
    runtime,
    reason: runtime.reason || 'no effective public ingress'
  };
}

export const __test = {
  cleanHttpsOrigin,
  runtimeMatchesConnection,
  verifiedConnection,
  verifiedForCurrentRecord
};
