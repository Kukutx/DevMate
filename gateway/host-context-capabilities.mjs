import { z } from 'zod';
import { readConfig, toolText } from './local-shared.mjs';
import { registerServerInitializer } from './server-extension-host.mjs';

const REGISTERED = Symbol.for('devmate.hostContextToolsRegistered');
const MAX_CONTEXT_CHARS = 250000;

function contextEntries(config) {
  const contexts = config?.hostContexts;
  if (!contexts || typeof contexts !== 'object' || Array.isArray(contexts)) return [];
  return Object.entries(contexts)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([id, value]) => ({ id, ...value }))
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function bounded(value) {
  const text = JSON.stringify(value ?? null);
  if (text.length <= MAX_CONTEXT_CHARS) return value;
  return {
    truncated: true,
    originalChars: text.length,
    preview: text.slice(0, MAX_CONTEXT_CHARS)
  };
}

function selectContext(config, hostId = '') {
  const entries = contextEntries(config);
  const requested = String(hostId || '').trim();
  if (requested) return entries.find(item => item.id === requested || item.hostId === requested) || null;
  const active = String(config?.activeHostId || '').trim();
  return entries.find(item => item.id === active || item.hostId === active) || entries[0] || null;
}

function registerTool(server, name, config, handler) {
  server.registerTool(name, { outputSchema: z.object({}).passthrough(), ...config }, handler);
}

export function registerHostContextTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;

  registerTool(server, 'host_context_list', {
    title: 'List host contexts',
    description: 'List bounded context summaries published by active DevMate hosts such as VS Code and Obsidian.',
    inputSchema: { workspaceId: z.string().optional() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, async () => {
    const config = readConfig();
    const hosts = contextEntries(config).map(context => ({
      id: context.id,
      hostId: context.hostId || context.id,
      kind: context.kind || 'unknown',
      updatedAt: context.updatedAt || context.capturedAt || null,
      workspaceRoot: context.workspaceRoot || null,
      activeDocument: context.activeDocument?.path || context.activeEditor?.path || null
    }));
    return toolText({ activeHostId: config.activeHostId || null, hosts });
  });

  registerTool(server, 'host_context', {
    title: 'Read host context',
    description: 'Read the current or requested DevMate host context, including the active editor or Obsidian note when available.',
    inputSchema: { hostId: z.string().optional(), workspaceId: z.string().optional() },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }, async ({ hostId = '' }) => {
    const config = readConfig();
    const context = selectContext(config, hostId);
    return toolText({
      activeHostId: config.activeHostId || null,
      requestedHostId: hostId || null,
      context: bounded(context)
    });
  });
}

export function installHostContextCapabilities(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: 'devmate.host-context-tools',
    order: 25,
    initialize: server => registerHostContextTools(server)
  });
}

export const __test = {
  bounded,
  contextEntries,
  selectContext
};
