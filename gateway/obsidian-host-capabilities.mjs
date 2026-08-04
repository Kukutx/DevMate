import http from 'node:http';
import { z } from 'zod';
import { readConfig, toolText } from './local-shared.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';

const REGISTERED = Symbol.for('devmate.obsidianHostToolsRegistered');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function bridgeConfig(config = readConfig()) {
  const bridge = config?.hostBridges?.obsidian;
  if (!bridge || typeof bridge !== 'object') return null;
  let url;
  try { url = new URL(String(bridge.url || '')); }
  catch { return null; }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash || !String(bridge.token || '')) return null;
  return { url: `${url.protocol}//${url.host}`, token: String(bridge.token), updatedAt: bridge.updatedAt || null };
}

function callBridge(action, args = {}, timeoutMs = 30000) {
  const bridge = bridgeConfig();
  if (!bridge) throw new Error('Obsidian host bridge is unavailable. Open the vault with the DevMate Obsidian plugin enabled.');
  const payload = Buffer.from(JSON.stringify({ action, args }), 'utf8');
  return new Promise((resolve, reject) => {
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
            reject(new Error(value.error || `Obsidian host returned HTTP ${response.statusCode}`));
            return;
          }
          resolve(value.result);
        } catch (error) {
          reject(new Error(`Invalid Obsidian host response: ${error.message || error}`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('Obsidian host request timed out')));
    request.on('error', reject);
    request.end(payload);
  });
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, { outputSchema: z.object({}).passthrough(), ...config }, handler);
}

export function registerObsidianHostTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;

  registerTool(server, 'obsidian_status', {
    title: 'Obsidian host status',
    description: 'Show whether an authenticated loopback Obsidian host bridge is available for the active workspace.',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    const bridge = bridgeConfig();
    if (!bridge) return toolText({ available: false });
    try { return toolText({ available: true, bridgeUpdatedAt: bridge.updatedAt, ...(await callBridge('status')) }); }
    catch (error) { return toolText({ available: false, error: error.message || String(error) }); }
  });

  registerTool(server, 'obsidian_vault_audit', {
    title: 'Audit Obsidian vault',
    description: 'Audit a vault or folder for orphan notes, unresolved links, duplicate basenames, and missing required Properties.',
    inputSchema: {
      workspaceId: z.string().optional(),
      folder: z.string().optional(),
      requiredProperties: z.array(z.string()).max(50).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => toolText(await callBridge('audit_vault', args)));

  registerTool(server, 'obsidian_note_create', {
    title: 'Create Obsidian note',
    description: 'Create one Markdown note through the Obsidian Vault API and record a rollback operation.',
    inputSchema: { workspaceId: z.string().optional(), path: z.string().min(1), content: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async args => toolText(await callBridge('create_note', args)));

  registerTool(server, 'obsidian_properties_update', {
    title: 'Update Obsidian Properties',
    description: 'Set or remove note Properties through FileManager.processFrontMatter with a conflict-aware rollback record.',
    inputSchema: {
      workspaceId: z.string().optional(),
      path: z.string().min(1),
      set: z.record(z.string(), z.unknown()).optional(),
      remove: z.array(z.string()).max(100).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async args => toolText(await callBridge('update_properties', args)));

  registerTool(server, 'obsidian_note_move', {
    title: 'Move Obsidian note',
    description: 'Move or rename one note through FileManager so Obsidian can maintain links, with rollback evidence.',
    inputSchema: { workspaceId: z.string().optional(), path: z.string().min(1), destination: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async args => toolText(await callBridge('move_note', args)));

  registerTool(server, 'obsidian_note_trash', {
    title: 'Trash Obsidian note',
    description: 'Move one note to the user-configured Obsidian trash and preserve content for rollback.',
    inputSchema: { workspaceId: z.string().optional(), path: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async args => toolText(await callBridge('trash_note', args)));

  registerTool(server, 'obsidian_operation_list', {
    title: 'List Obsidian operations',
    description: 'List recent recorded Obsidian host mutations and rollback state.',
    inputSchema: { workspaceId: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => toolText(await callBridge('operation_list', args)));

  registerTool(server, 'obsidian_operation_rollback', {
    title: 'Rollback Obsidian operation',
    description: 'Rollback one recorded Obsidian mutation. Conflicting later edits are rejected unless force=true.',
    inputSchema: { workspaceId: z.string().optional(), operationId: z.string().min(1), force: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }, async args => toolText(await callBridge('operation_rollback', args)));
}

export function installObsidianHostCapabilities(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.obsidian-host-tools',
    order: 27,
    initialize: server => registerObsidianHostTools(server)
  });
}

export const __test = { bridgeConfig };
