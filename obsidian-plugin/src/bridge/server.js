'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { updateConfig } = require('../../../host/runtime-controller.js');
const {
  BRIDGE_CAPABILITIES,
  BRIDGE_PROTOCOL_VERSION,
  MAX_BODY_BYTES
} = require('./constants.js');
const { OperationStore } = require('./operation-store.js');
const { PlanStore } = require('./plan-store.js');
const {
  createNote,
  moveNote,
  rollbackOperation,
  trashNote,
  updateProperties
} = require('./note-actions.js');
const {
  applyPropertiesBatch,
  previewPropertiesBatch,
  rollbackPropertiesBatch
} = require('./property-batch.js');
const { VaultIndex } = require('./vault-index.js');

function now() {
  return new Date().toISOString();
}

function isLoopback(request) {
  const address = request.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function timingSafeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jsonResponse(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(payload);
}

async function requestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error(`Request exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const value = text ? JSON.parse(text) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Request body must be a JSON object');
  return value;
}

class ObsidianHostBridge {
  constructor(plugin, controller) {
    this.plugin = plugin;
    this.controller = controller;
    this.server = null;
    this.token = crypto.randomBytes(32).toString('base64url');
    this.url = '';
    this.index = new VaultIndex(plugin);
    this.operationStore = new OperationStore(controller);
    this.planStore = new PlanStore(controller);
  }

  async action(action, args) {
    switch (action) {
      case 'status':
        this.index.ensureFresh();
        return {
          available: true,
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          capabilities: BRIDGE_CAPABILITIES,
          vault: this.plugin.app.vault.getName(),
          root: this.plugin.vaultRoot,
          index: {
            files: this.index.records.size,
            generation: this.index.generation,
            refreshedAt: this.index.refreshedAt
          }
        };
      case 'query_notes': return this.index.query(args);
      case 'schema_audit': return this.index.schema(args);
      case 'audit_vault': return this.index.audit(args);
      case 'create_note': return createNote(this.plugin, this.operationStore, args);
      case 'update_properties': return updateProperties(this.plugin, this.operationStore, args);
      case 'move_note': return moveNote(this.plugin, this.operationStore, args);
      case 'trash_note': return trashNote(this.plugin, this.operationStore, args);
      case 'properties_batch_preview': return previewPropertiesBatch(this.plugin, this.index, this.planStore, args);
      case 'properties_batch_apply': return applyPropertiesBatch(this.plugin, this.operationStore, this.planStore, args);
      case 'properties_batch_rollback': return rollbackPropertiesBatch(this.plugin, this.operationStore, this.planStore, args);
      case 'properties_batch_list': return { plans: this.planStore.listPublic(args.limit) };
      case 'operation_list': return { operations: this.operationStore.listPublic(args.limit) };
      case 'operation_rollback': return rollbackOperation(this.plugin, this.operationStore, args);
      default: throw new Error(`Unsupported Obsidian action: ${action}`);
    }
  }

  async handle(request, response) {
    if (!isLoopback(request)) {
      jsonResponse(response, 403, { ok: false, error: 'loopback_only' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/action') {
      jsonResponse(response, 404, { ok: false, error: 'not_found' });
      return;
    }
    const bearer = String(request.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    if (!timingSafeTokenEqual(bearer, this.token)) {
      jsonResponse(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      jsonResponse(response, 415, { ok: false, error: 'application_json_required' });
      return;
    }
    try {
      const body = await requestJson(request);
      const action = String(body.action || '');
      if (!BRIDGE_CAPABILITIES.includes(action)) throw new Error(`Unsupported Obsidian action: ${action}`);
      const result = await this.action(action, body.args || {});
      jsonResponse(response, 200, { ok: true, result });
    } catch (error) {
      jsonResponse(response, 400, { ok: false, error: error.message || String(error) });
    }
  }

  async start() {
    if (this.server) return { url: this.url };
    this.index.start();
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.maxConnections = 16;
    this.server.keepAliveTimeout = 5000;
    this.server.headersTimeout = 7000;
    this.server.requestTimeout = 15000;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    this.url = `http://127.0.0.1:${address.port}`;
    const runtimeConfig = this.controller.ensureConfig();
    updateConfig(this.controller.configFile, config => {
      config.hostBridges ||= {};
      config.hostBridges.obsidian = {
        url: this.url,
        token: this.token,
        pid: process.pid,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        capabilities: BRIDGE_CAPABILITIES,
        updatedAt: now(),
        workspaceRoot: this.plugin.vaultRoot,
        workspaceId: runtimeConfig.activeWorkspaceId || null
      };
      return config;
    });
    return { url: this.url };
  }

  async stop() {
    const token = this.token;
    try {
      updateConfig(this.controller.configFile, config => {
        if (config.hostBridges?.obsidian?.token === token) delete config.hostBridges.obsidian;
        return config;
      });
    } catch {}
    this.index.stop();
    const server = this.server;
    this.server = null;
    this.url = '';
    if (!server) return;
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

module.exports = {
  ObsidianHostBridge,
  __test: {
    isLoopback,
    requestJson,
    timingSafeTokenEqual
  }
};
