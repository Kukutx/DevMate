import http from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { readConfig, toolText } from './local-shared.mjs';
import { resolveWorkspace, writableWorkspaces } from './workspace-resolver.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';

const REGISTERED = Symbol.for('devmate.obsidianHostToolsRegistered');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_BRIDGE_PROTOCOL_VERSION = 1;

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function workspaceFor(config, requested = '') {
  return resolveWorkspace(config, requested);
}

function bridgeEntries(config) {
  return Object.entries(config?.hostBridges || {}).filter(([hostId, bridge]) => bridge && typeof bridge === 'object' && (
    hostId === 'obsidian' || bridge.kind === 'obsidian' || bridge.hostKind === 'obsidian' || String(bridge.hostId || hostId).startsWith('obsidian-')
  ));
}

function bridgeConfig(config = readConfig(), workspaceId = '') {
  const workspace = workspaceFor(config, workspaceId);
  const candidates = [];
  let attachedElsewhere = '';
  let rootMismatch = false;
  for (const [hostId, bridge] of bridgeEntries(config)) {
  let url;
  try { url = new URL(String(bridge.url || '')); }
  catch { continue; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) continue;
  if (url.username || url.password || url.search || url.hash || !String(bridge.token || '')) continue;
  if (bridge.workspaceId && bridge.workspaceId !== workspace.id) {
    attachedElsewhere ||= String(bridge.workspaceId);
    continue;
  }
  if (bridge.workspaceRoot && pathKey(bridge.workspaceRoot) !== pathKey(workspace.root)) {
    rootMismatch = true;
    continue;
  }
  if (!bridge.workspaceId && !bridge.workspaceRoot && writableWorkspaces(config).length > 1) continue;
  const protocolVersion = Number(bridge.protocolVersion || 1);
  if (!Number.isInteger(protocolVersion) || protocolVersion < MIN_BRIDGE_PROTOCOL_VERSION) continue;
  candidates.push({
    hostId: String(bridge.hostId || hostId),
    url: `${url.protocol}//${url.host}`,
    token: String(bridge.token),
    updatedAt: bridge.updatedAt || null,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    protocolVersion,
    capabilities: Array.isArray(bridge.capabilities) ? bridge.capabilities.map(String) : []
  });
  }
  if (candidates.length) {
    return candidates.sort((left, right) => Date.parse(right.updatedAt || '') - Date.parse(left.updatedAt || ''))[0];
  }
  if (attachedElsewhere) throw new Error(`Obsidian host bridge is attached to workspace ${attachedElsewhere}, not ${workspace.id}`);
  if (rootMismatch) throw new Error('Obsidian host bridge workspace root does not match the requested DevMate workspace');
  return null;
}

function callBridge(action, args = {}, timeoutMs = 30000) {
  const bridge = bridgeConfig(readConfig(), args.workspaceId);
  if (!bridge) throw new Error('Obsidian host bridge is unavailable. Open the vault with the DevMate Obsidian plugin enabled.');
  if (bridge.capabilities.length && !bridge.capabilities.includes(action)) {
    throw new Error(`The connected Obsidian host does not support action ${action}`);
  }
  const payload = Buffer.from(JSON.stringify({ action, args }), 'utf8');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.request(new URL('/v1/action', bridge.url), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: 'application/json'
      },
      timeout: timeoutMs
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) request.destroy(new Error('Obsidian host response is too large'));
        else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (response.statusCode < 200 || response.statusCode >= 300 || value.ok !== true) {
            finish(new Error(value.error || `Obsidian host returned HTTP ${response.statusCode}`));
            return;
          }
          finish(null, value.result);
        } catch (error) {
          finish(new Error(`Invalid Obsidian host response: ${error.message || error}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Obsidian host request timed out')));
    request.on('error', error => finish(error));
    request.end(payload);
  });
}

function registerTool(server, definition) {
  server.registerTool(definition.name, {
    title: definition.title,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: z.object({}).passthrough(),
    annotations: definition.annotations
  }, async args => toolText(await callBridge(definition.action, args || {}, definition.timeoutMs)));
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const idempotentMutation = { ...mutation, idempotentHint: true };
const planning = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const selectorSchema = {
  folder: z.string().optional(),
  paths: z.array(z.string()).max(500).optional(),
  tags: z.array(z.string()).max(100).optional(),
  tagsAll: z.array(z.string()).max(100).optional(),
  tagsAny: z.array(z.string()).max(100).optional(),
  propertyExists: z.array(z.string()).max(100).optional(),
  propertyMissing: z.array(z.string()).max(100).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  search: z.string().max(1000).optional(),
  modifiedAfter: z.string().optional(),
  modifiedBefore: z.string().optional()
};

const definitions = [
  {
    name: 'obsidian_status', action: 'status', title: 'Obsidian host status',
    description: 'Show the authenticated loopback Obsidian host bridge, protocol, capabilities, vault, index freshness, and local request timing summaries.',
    inputSchema: { workspaceId: z.string().optional() }, annotations: readOnly
  },
  {
    name: 'obsidian_note_query', action: 'query_notes', title: 'Query Obsidian notes',
    description: 'Query the incremental Obsidian vault index by folder, tags, Properties, text metadata, dates, and paths.',
    inputSchema: {
      workspaceId: z.string().optional(), ...selectorSchema,
      sort: z.enum(['path', 'name', 'modified', 'created', 'size']).optional(),
      order: z.enum(['asc', 'desc']).optional(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      includeProperties: z.boolean().optional()
    }, annotations: readOnly
  },
  {
    name: 'obsidian_content_search', action: 'search_content', title: 'Search Obsidian note content',
    description: 'Search Markdown note bodies with bounded concurrent Vault.cachedRead calls, deterministic scoring, line numbers, snippets, and metadata selectors.',
    inputSchema: {
      workspaceId: z.string().optional(), ...selectorSchema,
      query: z.string().min(1).max(500),
      mode: z.enum(['phrase', 'all', 'any']).optional(),
      caseSensitive: z.boolean().optional(),
      maxCandidates: z.number().int().min(1).max(2000).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      snippetChars: z.number().int().min(80).max(1000).optional(),
      maxFileBytes: z.number().int().min(4096).max(5 * 1024 * 1024).optional(),
      concurrency: z.number().int().min(1).max(16).optional()
    }, annotations: readOnly, timeoutMs: 120000
  },
  {
    name: 'obsidian_note_graph', action: 'graph_notes', title: 'Explore Obsidian note graph',
    description: 'Explore deterministic inbound, outbound, or bidirectional note-link neighborhoods from one or more root notes with bounded depth, nodes, and edges.',
    inputSchema: {
      workspaceId: z.string().optional(),
      paths: z.array(z.string()).min(1).max(50),
      direction: z.enum(['inbound', 'outbound', 'both']).optional(),
      depth: z.number().int().min(1).max(3).optional(),
      maxNodes: z.number().int().min(1).max(500).optional(),
      maxEdges: z.number().int().min(1).max(2000).optional(),
      includeProperties: z.boolean().optional()
    }, annotations: readOnly
  },
  {
    name: 'obsidian_schema_audit', action: 'schema_audit', title: 'Audit Obsidian Properties schema',
    description: 'Inspect Property coverage, inferred value types, inconsistent types, examples, folders, and tags for selected notes.',
    inputSchema: {
      workspaceId: z.string().optional(), ...selectorSchema,
      examplesPerProperty: z.number().int().min(1).max(10).optional()
    }, annotations: readOnly
  },
  {
    name: 'obsidian_vault_audit', action: 'audit_vault', title: 'Audit Obsidian vault',
    description: 'Audit selected notes for orphan notes, unresolved links, duplicate basenames, and missing required Properties.',
    inputSchema: {
      workspaceId: z.string().optional(), ...selectorSchema,
      requiredProperties: z.array(z.string()).max(50).optional()
    }, annotations: readOnly
  },
  {
    name: 'obsidian_note_create', action: 'create_note', title: 'Create Obsidian note',
    description: 'Create one Markdown note through the Obsidian Vault API and record a rollback operation.',
    inputSchema: { workspaceId: z.string().optional(), path: z.string().min(1), content: z.string().optional() }, annotations: mutation
  },
  {
    name: 'obsidian_properties_update', action: 'update_properties', title: 'Update Obsidian Properties',
    description: 'Set or remove note Properties through FileManager.processFrontMatter with a conflict-aware rollback record.',
    inputSchema: {
      workspaceId: z.string().optional(), path: z.string().min(1),
      set: z.record(z.string(), z.unknown()).optional(), remove: z.array(z.string()).max(100).optional()
    }, annotations: mutation
  },
  {
    name: 'obsidian_note_move', action: 'move_note', title: 'Move Obsidian note',
    description: 'Move or rename one note through FileManager so Obsidian can maintain links, with rollback evidence.',
    inputSchema: { workspaceId: z.string().optional(), path: z.string().min(1), destination: z.string().min(1) }, annotations: mutation
  },
  {
    name: 'obsidian_note_trash', action: 'trash_note', title: 'Trash Obsidian note',
    description: 'Move one note to the user-configured Obsidian trash and preserve content for rollback.',
    inputSchema: { workspaceId: z.string().optional(), path: z.string().min(1) }, annotations: mutation
  },
  {
    name: 'obsidian_properties_batch_preview', action: 'properties_batch_preview', title: 'Preview batch Property changes',
    description: 'Create a time-limited, hash-bound plan for setting or removing Properties across selected notes without modifying the vault.',
    inputSchema: {
      workspaceId: z.string().optional(),
      selector: z.object(selectorSchema).optional(),
      set: z.record(z.string(), z.unknown()).optional(),
      remove: z.array(z.string()).max(100).optional()
    }, annotations: planning
  },
  {
    name: 'obsidian_properties_batch_apply', action: 'properties_batch_apply', title: 'Apply batch Property plan',
    description: 'Apply a previously previewed Property plan after preflighting every note hash; failures trigger best-effort automatic rollback.',
    inputSchema: { workspaceId: z.string().optional(), planId: z.string().min(1) }, annotations: idempotentMutation,
    timeoutMs: 120000
  },
  {
    name: 'obsidian_properties_batch_rollback', action: 'properties_batch_rollback', title: 'Rollback batch Property plan',
    description: 'Rollback all operations from an applied batch Property plan in reverse order, with conflict protection unless force=true.',
    inputSchema: { workspaceId: z.string().optional(), planId: z.string().min(1), force: z.boolean().optional() }, annotations: idempotentMutation,
    timeoutMs: 120000
  },
  {
    name: 'obsidian_properties_batch_list', action: 'properties_batch_list', title: 'List batch Property plans',
    description: 'List recent Property batch plans, statuses, expiry, application, rollback, and operation IDs.',
    inputSchema: { workspaceId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }, annotations: readOnly
  },
  {
    name: 'obsidian_operation_list', action: 'operation_list', title: 'List Obsidian operations',
    description: 'List recent recorded Obsidian host mutations and rollback state.',
    inputSchema: { workspaceId: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: readOnly
  },
  {
    name: 'obsidian_operation_rollback', action: 'operation_rollback', title: 'Rollback Obsidian operation',
    description: 'Rollback one recorded Obsidian mutation. Conflicting later edits are rejected unless force=true.',
    inputSchema: { workspaceId: z.string().optional(), operationId: z.string().min(1), force: z.boolean().optional() }, annotations: idempotentMutation
  }
];

export function registerObsidianHostTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;
  for (const definition of definitions) registerTool(server, definition);
}

export function installObsidianHostCapabilities(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.obsidian-host-tools',
    order: 27,
    initialize: server => registerObsidianHostTools(server)
  });
}

export const __test = { bridgeConfig, bridgeEntries, definitions, selectorSchema, workspaceFor };
