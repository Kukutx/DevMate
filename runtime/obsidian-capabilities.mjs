import { z } from 'zod';

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
    description: 'Show the attached Obsidian host: vault name and root, bridge protocol version and operations, index freshness, pending work and per-operation request counts and timings.',
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
    description: 'List recent recorded Obsidian mutations and their rollback state. With operationId, report what became of that one operation (applied, in progress, not applied, failed): use it after an outcome_unknown or timeout error, also while the vault is detached.',
    inputSchema: { workspaceId: z.string().optional(), limit: z.number().int().min(1).max(500).optional(), operationId: z.string().min(1).max(160).optional() }, annotations: readOnly
  },
  {
    name: 'obsidian_operation_rollback', action: 'operation_rollback', title: 'Rollback Obsidian operation',
    description: 'Rollback one recorded Obsidian mutation. Conflicting later edits are rejected unless force=true.',
    inputSchema: { workspaceId: z.string().optional(), operationId: z.string().min(1), force: z.boolean().optional() }, annotations: idempotentMutation
  }
];


export const obsidianCapabilities = Object.freeze(definitions.map(definition => {
  const {workspaceId, ...shape}=definition.inputSchema;
  return {...definition,name:definition.name.replace('obsidian_','obsidian.'),schema:z.object(shape).strict()};
}));
