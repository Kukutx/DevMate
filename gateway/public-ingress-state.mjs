import path from 'node:path';
import verification from '../shared/public-ingress-verification.cjs';
import tunnelRecordStore from '../vscode-host/shared-tunnel-record-store.js';
import { CONFIG_PATH } from './local-shared.mjs';

const { verifiedForCurrentRecord } = verification;
const { SharedTunnelRecordStore } = tunnelRecordStore;

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

function runtimeMatchesDeployment(config, record, publicUrl = cleanHttpsOrigin(record?.publicUrl || '')) {
  const desiredProvider = String(config?.deployment?.tunnelProvider || '').trim().toLowerCase();
  const actualProvider = String(record?.provider || '').trim().toLowerCase();
  if (desiredProvider && actualProvider !== desiredProvider) {
    return {
      matches: false,
      reason: `shared tunnel provider ${actualProvider || 'unknown'} does not match configured provider ${desiredProvider}`
    };
  }

  const configuredUrl = cleanHttpsOrigin(config?.deployment?.publicUrl || '');
  if (configuredUrl && publicUrl !== configuredUrl) {
    return {
      matches: false,
      reason: `shared tunnel URL ${publicUrl || 'unavailable'} does not match configured stable URL ${configuredUrl}`
    };
  }
  return { matches: true, reason: '' };
}

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
