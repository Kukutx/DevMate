import { z } from 'zod';
import { serverExtensionInstanceStatus } from '../server-extension-host.mjs';
import {
  jobTargetPolicy,
  ownerOnlyTool,
  requiredCapabilityForTool,
  workspaceScopedTool
} from '../tool-policy.mjs';
import { definePlugin } from './plugin-sdk.mjs';

const MAX_SEARCH_RESULTS = 100;
const FAMILY_RULES = Object.freeze([
  ['browser', /^(?:browser_|web_preview_)/],
  ['godot', /^godot_/],
  ['obsidian', /^obsidian_/],
  ['git', /^git_/],
  ['jobs', /^(?:job_|runner_|deployment_drain_)/],
  ['collaboration', /^(?:team_|workspace_lease_|codex_)/],
  ['deployment', /^(?:deployment_|published_preview_)/],
  ['plugins', /^(?:plugin_|automation_|devmate_)/],
  ['process', /^(?:run_|start_process|stop_process|send_process_input|process_|list_processes|list_project_scripts|list_configured_commands|local_capabilities_)/],
  ['workspace', /^(?:workspace_|list_workspaces|project_|vscode_|active_editor_|list_diagnostics|list_files|search_text|read_file|write_file|create_file|apply_patch|delete_file|move_file|show_changes|work_session_)/]
]);

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function toolFamily(name) {
  const value = String(name || '');
  for (const [family, pattern] of FAMILY_RULES) if (pattern.test(value)) return family;
  return 'platform';
}

export function describeToolRegistration(registration) {
  const annotations = { ...(registration?.annotations || {}) };
  const name = String(registration?.name || '');
  const job = jobTargetPolicy(name);
  return {
    name,
    title: String(registration?.title || ''),
    description: String(registration?.description || ''),
    family: toolFamily(name),
    capability: requiredCapabilityForTool(name, annotations),
    workspaceScoped: workspaceScopedTool(name),
    ownerOnly: ownerOnlyTool(name),
    job: job ? { requiredCapabilities: [...job.requiredCapabilities], pluginId: job.pluginId } : null,
    annotations: {
      readOnlyHint: annotations.readOnlyHint === true,
      destructiveHint: annotations.destructiveHint === true,
      idempotentHint: annotations.idempotentHint === true,
      openWorldHint: annotations.openWorldHint === true
    },
    hasInputSchema: registration?.hasInputSchema === true,
    hasOutputSchema: registration?.hasOutputSchema === true
  };
}

export function buildToolCatalog(server) {
  return serverExtensionInstanceStatus(server).tools
    .map(describeToolRegistration)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function searchableText(tool) {
  return `${tool.name} ${tool.title} ${tool.description} ${tool.family} ${tool.capability}`.toLowerCase();
}

function searchScore(tool, query) {
  const needle = compact(query).toLowerCase();
  if (!needle) return 1;
  const haystack = searchableText(tool);
  if (!haystack.includes(needle)) {
    const tokens = needle.split(/\s+/).filter(Boolean);
    if (!tokens.every(token => haystack.includes(token))) return 0;
  }
  let score = 10;
  if (tool.name.toLowerCase() === needle) score += 100;
  else if (tool.name.toLowerCase().startsWith(needle)) score += 70;
  else if (tool.name.toLowerCase().includes(needle)) score += 50;
  if (tool.title.toLowerCase().includes(needle)) score += 25;
  if (tool.description.toLowerCase().includes(needle)) score += 10;
  return score;
}

export function searchCatalogEntries(tools, { query = '', family = '', capability = '', limit = 20 } = {}) {
  const familyFilter = compact(family).toLowerCase();
  const capabilityFilter = compact(capability).toLowerCase();
  const max = Math.min(MAX_SEARCH_RESULTS, Math.max(1, Number(limit) || 20));
  return tools
    .filter(tool => !familyFilter || tool.family === familyFilter)
    .filter(tool => !capabilityFilter || tool.capability === capabilityFilter)
    .map(tool => ({ tool, score: searchScore(tool, query) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => (b.score - a.score) || a.tool.name.localeCompare(b.tool.name))
    .slice(0, max)
    .map(entry => entry.tool);
}

function summarize(tools, includeDescriptions = true) {
  const families = {};
  const capabilities = {};
  for (const tool of tools) {
    families[tool.family] = (families[tool.family] || 0) + 1;
    capabilities[tool.capability] = (capabilities[tool.capability] || 0) + 1;
  }
  return {
    count: tools.length,
    families,
    capabilities,
    tools: includeDescriptions ? tools : tools.map(({ description, ...tool }) => tool)
  };
}

export const toolDiscoveryPlugin = definePlugin({
  manifest: {
    id: 'devmate.tool-discovery',
    name: 'Tool Discovery',
    version: '1.0.0',
    apiVersion: '1',
    description: 'Model-neutral discovery for the currently registered DevMate MCP tool surface.',
    core: true,
    defaultEnabled: true,
    toolPrefixes: [],
    capabilities: ['tools', 'tool-discovery', 'model-neutral-harness'],
    provides: [],
    consumes: [],
    permissions: { executablePatterns: [] }
  },
  activate(context) {
    const { server } = context;
    server.registerTool('devmate_tool_catalog', {
      title: 'DevMate tool catalog',
      description: 'Describe the currently registered DevMate MCP tools, their families, authorization capability, scope, and safety annotations without changing tool availability.',
      inputSchema: {
        family: z.string().max(100).optional(),
        capability: z.string().max(100).optional(),
        includeDescriptions: z.boolean().optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ family = '', capability = '', includeDescriptions = true }) => {
      const tools = searchCatalogEntries(buildToolCatalog(server), { family, capability, limit: MAX_SEARCH_RESULTS });
      return context.toolText(summarize(tools, includeDescriptions));
    });

    server.registerTool('devmate_tool_search', {
      title: 'Search DevMate tools',
      description: 'Search the currently registered DevMate MCP tool surface by intent keywords, family, or capability. This is descriptive only and does not alter authorization or registration.',
      inputSchema: {
        query: z.string().max(500).optional(),
        family: z.string().max(100).optional(),
        capability: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ query = '', family = '', capability = '', limit = 20 }) => {
      const matches = searchCatalogEntries(buildToolCatalog(server), { query, family, capability, limit });
      return context.toolText({ query, family: family || null, capability: capability || null, count: matches.length, tools: matches });
    });
  }
});

export const __test = { FAMILY_RULES, MAX_SEARCH_RESULTS, searchScore, summarize };
