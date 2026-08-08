'use strict';

const { normalizePublicOrigin } = require('../../host/public-mcp.js');
const { runtimeMatchesDeployment } = require('../../shared/public-ingress-verification.cjs');
const { SharedTunnelRecordStore } = require('../../vscode-host/shared-tunnel-record-store.js');

function cleanOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return normalizePublicOrigin(text);
}

function explicitOrigin(publicOrigin = '') {
  const explicit = cleanOrigin(publicOrigin);
  if (!explicit) return null;
  return {
    source: 'obsidian-setting',
    publicOrigin: explicit,
    provider: 'external',
    ownerHostId: ''
  };
}

function readySharedTunnel({ stateDirectory, port, config = null, logger = () => {} } = {}) {
  const numericPort = Number(port);
  if (!stateDirectory || !Number.isInteger(numericPort) || numericPort <= 0) return null;
  const store = new SharedTunnelRecordStore({ stateDirectory, logger });
  const record = store.read();
  if (!record || record.status !== 'ready' || Number(record.port) !== numericPort || !record.publicUrl) return null;
  const publicOrigin = cleanOrigin(record.publicUrl);
  const deploymentMatch = runtimeMatchesDeployment(config, record, publicOrigin);
  if (!deploymentMatch.matches) {
    logger(`Ignoring stale shared tunnel record: ${deploymentMatch.reason}`);
    return null;
  }
  return {
    source: 'shared-tunnel',
    publicOrigin,
    provider: record.provider,
    ownerHostId: record.hostId || '',
    record
  };
}

function deploymentOrigin(config = null) {
  const deployment = cleanOrigin(config?.deployment?.publicUrl || '');
  if (!deployment) return null;
  return {
    source: 'deployment-config',
    publicOrigin: deployment,
    provider: String(config?.deployment?.tunnelProvider || 'external'),
    ownerHostId: ''
  };
}

function configuredOrigin({ publicOrigin = '', config = null } = {}) {
  return explicitOrigin(publicOrigin) || deploymentOrigin(config);
}

function resolvePublicConnection({ stateDirectory, port, publicOrigin = '', config = null, logger = () => {} } = {}) {
  return explicitOrigin(publicOrigin) ||
    readySharedTunnel({ stateDirectory, port, config, logger }) ||
    deploymentOrigin(config);
}

module.exports = {
  cleanOrigin,
  configuredOrigin,
  deploymentOrigin,
  explicitOrigin,
  readySharedTunnel,
  resolvePublicConnection
};
