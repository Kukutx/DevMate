'use strict';

const { normalizePublicOrigin } = require('../../host/public-mcp.js');
const { SharedTunnelRecordStore } = require('../../vscode-host/shared-tunnel-record-store.js');

function cleanOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return normalizePublicOrigin(text);
}

function readySharedTunnel({ stateDirectory, port, logger = () => {} } = {}) {
  const numericPort = Number(port);
  if (!stateDirectory || !Number.isInteger(numericPort) || numericPort <= 0) return null;
  const store = new SharedTunnelRecordStore({ stateDirectory, logger });
  const record = store.read();
  if (!record || record.status !== 'ready' || Number(record.port) !== numericPort || !record.publicUrl) return null;
  return {
    source: 'shared-tunnel',
    publicOrigin: cleanOrigin(record.publicUrl),
    provider: record.provider,
    ownerHostId: record.hostId || '',
    record
  };
}

function configuredOrigin({ publicOrigin = '', config = null } = {}) {
  const explicit = cleanOrigin(publicOrigin);
  if (explicit) {
    return {
      source: 'obsidian-setting',
      publicOrigin: explicit,
      provider: 'external',
      ownerHostId: ''
    };
  }
  const deployment = cleanOrigin(config?.deployment?.publicUrl || '');
  if (!deployment) return null;
  return {
    source: 'deployment-config',
    publicOrigin: deployment,
    provider: String(config?.deployment?.tunnelProvider || 'external'),
    ownerHostId: ''
  };
}

function resolvePublicConnection({ stateDirectory, port, publicOrigin = '', config = null, logger = () => {} } = {}) {
  return readySharedTunnel({ stateDirectory, port, logger }) || configuredOrigin({ publicOrigin, config });
}

module.exports = {
  cleanOrigin,
  configuredOrigin,
  readySharedTunnel,
  resolvePublicConnection
};
