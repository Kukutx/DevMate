import path from 'node:path';
import verification from '../shared/public-ingress-verification.cjs';
import tunnelRecordStore from '../vscode-host/shared-tunnel-record-store.js';
import { CONFIG_PATH } from './local-shared.mjs';

const {
  cleanHttpsOrigin,
  runtimeMatchesDeployment,
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
    const deploymentMatch = runtimeMatchesDeployment(config, record, publicUrl);
    if (!deploymentMatch.matches) {
      return {
        available: false,
        verified: false,
        source: 'runtime',
        publicUrl: '',
        provider: record.provider,
        hostId: record.hostId || '',
        readyAt: record.readyAt || null,
        reason: deploymentMatch.reason,
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
  const configured = cleanHttpsOrigin(config?.deployment?.publicUrl || '');
  const runtime = runtimePublicIngress(config, options);
  if (configured) {
    return {
      available: true,
      verified: false,
      source: 'configured',
      publicUrl: configured,
      provider: config?.deployment?.tunnelProvider || null,
      runtime
    };
  }
  if (config?.deployment?.mode === 'team' && runtime.available && runtime.verified) return runtime;
  return {
    available: false,
    verified: false,
    source: 'none',
    publicUrl: '',
    provider: config?.deployment?.tunnelProvider || null,
    runtime,
    reason: config?.deployment?.mode === 'production'
      ? 'production requires a configured stable public URL'
      : runtime.reason || 'no effective public ingress'
  };
}

export const __test = {
  cleanHttpsOrigin,
  runtimeMatchesDeployment,
  verifiedForCurrentRecord
};
