import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import configStore from '../shared/config-store.cjs';
import { normalizeInstanceConfig } from '../gateway/team-access.mjs';
import { normalizeRunnerControlConfig } from '../gateway/runner-access.mjs';
import { builtinPlugins } from '../gateway/plugins/builtins.mjs';
import { configFile, readConfig, standaloneStateSeparation } from './standalone-runtime.mjs';
import { daemonStatus, restartDaemon, startDaemon, stopDaemon } from './standalone-daemon.mjs';

const { activateInstanceWorkspace, ensureInstanceConfig, updateConfig } = configStore;

function json(value) {
  return JSON.stringify(value, null, 2);
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return numeric;
}

function booleanOption(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${label} must be a boolean`);
}

function shellWords(line) {
  const source = String(line || '');
  const words = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote) {
        quote = '';
        continue;
      }
      if (char === '\\' && source[index + 1] === quote) {
        current += quote;
        index += 1;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error(`Unclosed ${quote} quote`);
  if (current) words.push(current);
  return words;
}

function normalizeConfig(file) {
  return normalizeRunnerControlConfig(normalizeInstanceConfig(readConfig(file)));
}

function workspacePublic(item, activeWorkspaceId) {
  return {
    id: item.id,
    name: item.name,
    root: item.root,
    mode: item.mode,
    reference: !!item.reference,
    active: item.id === activeWorkspaceId
  };
}

function workspaceList(options = {}) {
  const file = configFile(options);
  const config = normalizeConfig(file);
  return {
    config: file,
    activeWorkspaceId: config.activeWorkspaceId || null,
    workspaces: config.workspaces.map(item => workspacePublic(item, config.activeWorkspaceId))
  };
}

function workspaceAdd(options = {}, positional = []) {
  const file = configFile(options);
  const root = path.resolve(String(options.path || positional[0] || process.cwd()));
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Workspace is not a directory: ${root}`);
  const activate = booleanOption(options.use, false, '--use');
  const current = normalizeConfig(file);
  const roots = [...current.workspaces.map(item => item.root), root];
  const separation = standaloneStateSeparation(file, roots);
  if (!separation.ok) throw new Error(`Workspace overlaps DevMate standalone state: ${separation.reason}`);
  const config = ensureInstanceConfig({
    configFile: file,
    workspaceRoot: root,
    preferredPort: Number(current.server?.port || 8787),
    appVersion: current.appVersion,
    defaultConnectionProvider: current.connection.provider
  });
  const workspace = config.workspaces.find(item => path.resolve(item.root) === root);
  if (activate) activateInstanceWorkspace({ configFile: file, workspaceRoot: root });
  return { added: workspacePublic(workspace, activate ? workspace.id : config.activeWorkspaceId), config: file };
}

function workspaceUse(options = {}, positional = []) {
  const file = configFile(options);
  const requested = String(options.id || options.path || positional[0] || '').trim();
  if (!requested) throw new Error('workspace use requires an id or path');
  const config = normalizeConfig(file);
  const usable = item => item && !item.reference && item.mode !== 'readonly';
  const byId = config.workspaces.find(item => usable(item) && item.id === requested);
  const byPath = config.workspaces.find(item => {
    if (!usable(item)) return false;
    try { return path.resolve(item.root) === path.resolve(requested); }
    catch { return false; }
  });
  const workspace = byId || byPath;
  if (!workspace) throw new Error(`Writable workspace not found: ${requested}`);
  const updated = activateInstanceWorkspace({ configFile: file, workspaceRoot: workspace.root });
  return { active: workspacePublic(updated.workspaces.find(item => item.id === updated.activeWorkspaceId), updated.activeWorkspaceId), config: file };
}

function workspaceRemove(options = {}, positional = []) {
  const file = configFile(options);
  const id = String(options.id || positional[0] || '').trim();
  if (!id) throw new Error('workspace remove requires an id');
  let removed = null;
  let disabledMembers = [];
  let disabledRunners = [];
  const updated = updateConfig(file, current => {
    const config = normalizeRunnerControlConfig(normalizeInstanceConfig(current));
    const index = config.workspaces.findIndex(item => item.id === id && !item.reference);
    if (index < 0) throw new Error(`Workspace not found: ${id}`);
    removed = config.workspaces[index];
    const writable = config.workspaces.filter(item => !item.reference && item.mode !== 'readonly');
    if (removed.mode !== 'readonly' && writable.length <= 1) throw new Error('Cannot remove the last writable workspace');
    config.workspaces.splice(index, 1);
    const nextActive = config.activeWorkspaceId === id
      ? config.workspaces.find(item => !item.reference && item.mode !== 'readonly')
      : config.workspaces.find(item => item.id === config.activeWorkspaceId && !item.reference && item.mode !== 'readonly');
    config.activeWorkspaceId = nextActive?.id || null;
    for (const item of config.workspaces) {
      if (!item || item.reference) continue;
      item.role = item.id === config.activeWorkspaceId ? 'active' : 'workspace';
    }
    disabledMembers = [];
    for (const member of config.team.members) {
      if (!Array.isArray(member.workspaceIds) || !member.workspaceIds.includes(id)) continue;
      member.workspaceIds = member.workspaceIds.filter(value => value !== id);
      member.authVersion = Math.max(1, Number(member.authVersion) || 1) + 1;
      member.updatedAt = new Date().toISOString();
      if (!member.workspaceIds.length) {
        member.disabled = true;
        disabledMembers.push(member.id);
      }
    }
    disabledRunners = [];
    for (const credential of config.runnerControl.credentials) {
      if (!Array.isArray(credential.workspaceIds) || !credential.workspaceIds.includes(id)) continue;
      credential.workspaceIds = credential.workspaceIds.filter(value => value !== id);
      credential.updatedAt = new Date().toISOString();
      if (!credential.workspaceIds.length) {
        credential.disabled = true;
        disabledRunners.push(credential.id);
      }
    }
    return config;
  });
  return {
    removed: workspacePublic(removed, updated.activeWorkspaceId),
    activeWorkspaceId: updated.activeWorkspaceId,
    disabledMembers,
    disabledRunners,
    config: file
  };
}

function pluginMap() {
  return new Map(builtinPlugins.map(plugin => [plugin.manifest.id, plugin]));
}

function dependencyClosure(id, map, output = new Set()) {
  const plugin = map.get(id);
  if (!plugin) throw new Error(`Unknown DevMate plugin: ${id}`);
  for (const dependency of plugin.manifest.dependencies || []) {
    if (output.has(dependency)) continue;
    output.add(dependency);
    dependencyClosure(dependency, map, output);
  }
  return output;
}

function pluginList(options = {}) {
  const file = configFile(options);
  const config = normalizeConfig(file);
  const enabled = new Set(config.plugins?.enabled || []);
  return {
    config: file,
    plugins: builtinPlugins.map(plugin => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      description: plugin.manifest.description,
      enabled: plugin.manifest.core === true || plugin.manifest.defaultEnabled === true || enabled.has(plugin.manifest.id),
      explicitlyEnabled: enabled.has(plugin.manifest.id),
      dependencies: [...(plugin.manifest.dependencies || [])]
    }))
  };
}

function pluginEnable(options = {}, positional = []) {
  const file = configFile(options);
  const id = String(options.id || positional[0] || '').trim();
  if (!id) throw new Error('plugin enable requires an id');
  const map = pluginMap();
  const plugin = map.get(id);
  if (!plugin) throw new Error(`Unknown DevMate plugin: ${id}`);
  let added = [];
  updateConfig(file, current => {
    const config = normalizeInstanceConfig(current);
    if (config.permissions?.profile !== 'fullAccess') throw new Error('Enabling plugins requires the fullAccess permission profile');
    config.plugins ||= { enabled: [], settings: {} };
    config.plugins.enabled ||= [];
    const requested = new Set([id, ...dependencyClosure(id, map)]);
    added = [...requested].filter(pluginId => {
      const candidate = map.get(pluginId);
      return candidate && !candidate.manifest.core && !config.plugins.enabled.includes(pluginId);
    });
    config.plugins.enabled = [...new Set([...config.plugins.enabled, ...added])];
    return config;
  });
  return { enabled: id, dependenciesEnabled: added.filter(value => value !== id), config: file };
}

function pluginDisable(options = {}, positional = []) {
  const file = configFile(options);
  const id = String(options.id || positional[0] || '').trim();
  if (!id) throw new Error('plugin disable requires an id');
  const cascade = booleanOption(options.cascade, false, '--cascade');
  const map = pluginMap();
  const target = map.get(id);
  if (!target) throw new Error(`Unknown DevMate plugin: ${id}`);
  if (target.manifest.core) throw new Error(`Core plugin cannot be disabled: ${id}`);
  let cascaded = [];
  updateConfig(file, current => {
    const config = normalizeInstanceConfig(current);
    if (config.permissions?.profile !== 'fullAccess') throw new Error('Disabling plugins requires the fullAccess permission profile');
    const enabled = new Set(config.plugins?.enabled || []);
    const remove = new Set([id]);
    let changed = true;
    while (cascade && changed) {
      changed = false;
      for (const plugin of builtinPlugins) {
        if (remove.has(plugin.manifest.id) || !enabled.has(plugin.manifest.id)) continue;
        if ((plugin.manifest.dependencies || []).some(dependency => remove.has(dependency))) {
          remove.add(plugin.manifest.id);
          changed = true;
        }
      }
    }
    const dependents = [...enabled].filter(otherId => otherId !== id && (map.get(otherId)?.manifest.dependencies || []).includes(id));
    if (dependents.length && !cascade) throw new Error(`Plugin ${id} is required by: ${dependents.join(', ')}. Pass --cascade to disable them too.`);
    config.plugins.enabled = (config.plugins?.enabled || []).filter(pluginId => !remove.has(pluginId));
    cascaded = [...remove].filter(pluginId => pluginId !== id);
    return config;
  });
  return { disabled: id, cascaded, config: file };
}

function localMcpConfig(options = {}) {
  const file = configFile(options);
  const config = normalizeConfig(file);
  return { file, config, url: new URL(`http://127.0.0.1:${config.server.port}${config.server.mcpPath || '/mcp'}`) };
}

async function withClient(options, operation) {
  const { file, config, url } = localMcpConfig(options);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client(
    { name: 'devmate-cli', version: config.appVersion || 'unknown' },
    { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
  try {
    await client.connect(transport, { timeout: 15000 });
    return await operation(client, { file, config, url });
  } finally {
    await client.close().catch(() => {});
  }
}

async function toolList(options = {}) {
  return withClient(options, async client => {
    const result = await client.listTools();
    return { tools: (result.tools || []).map(tool => ({ name: tool.name, description: tool.description || '' })) };
  });
}

function parseJsonArgs(options = {}) {
  const raw = options.args ?? options.arguments ?? '{}';
  if (raw && typeof raw === 'object') return raw;
  let value;
  try { value = JSON.parse(String(raw || '{}')); }
  catch (error) { throw new Error(`--args must be valid JSON: ${error.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('--args must decode to a JSON object');
  return value;
}

async function toolCall(options = {}, positional = []) {
  const name = String(options.name || positional[0] || '').trim();
  if (!name) throw new Error('tool call requires a tool name');
  const args = parseJsonArgs(options);
  const timeoutMs = boundedInteger(options.timeout, 60000, 1000, 600000, '--timeout');
  return withClient(options, client => client.callTool({ name, arguments: args }, { timeout: timeoutMs, maxTotalTimeout: timeoutMs }));
}

async function jobCommand(action, options = {}, positional = []) {
  const id = String(options.id || positional[0] || '').trim();
  const workspaceId = options.workspace || options['workspace-id'];
  if (action === 'list') {
    return toolCall({ ...options, name: 'job_list', args: json({
      ...(options.status ? { status: options.status } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(options.limit ? { limit: Number(options.limit) } : {})
    }) });
  }
  if (!id) throw new Error(`job ${action} requires an id`);
  const args = { id, ...(workspaceId ? { workspaceId } : {}) };
  if (action === 'status') return toolCall({ ...options, name: 'job_status', args: json({
    ...args,
    includeArguments: booleanOption(options.arguments, false, '--arguments'),
    includeResult: booleanOption(options.result, true, '--result')
  }) });
  if (action === 'cancel') return toolCall({ ...options, name: 'job_cancel', args: json({
    ...args,
    force: booleanOption(options.force, false, '--force')
  }) });
  if (action === 'retry') return toolCall({ ...options, name: 'job_retry', args: json(args) });
  if (action === 'artifacts') return toolCall({ ...options, name: 'job_artifacts', args: json(args) });
  throw new Error(`Unknown job command: ${action}`);
}

export async function executeExtended({ command, options = {}, positional = [] }) {
  const action = positional[0] || '';
  if (command === 'start') return { handled: true, value: await startDaemon(options) };
  if (command === 'stop') return { handled: true, value: await stopDaemon(options) };
  if (command === 'restart') return { handled: true, value: await restartDaemon(options) };
  if (command === 'runtime-status') return { handled: true, value: await daemonStatus(options) };
  if (command === 'workspace') {
    if (!action || action === 'list') return { handled: true, value: workspaceList(options) };
    if (action === 'add') return { handled: true, value: workspaceAdd(options, positional.slice(1)) };
    if (action === 'use') return { handled: true, value: workspaceUse(options, positional.slice(1)) };
    if (action === 'remove') return { handled: true, value: workspaceRemove(options, positional.slice(1)) };
    throw new Error(`Unknown workspace command: ${action}`);
  }
  if (command === 'plugin') {
    if (!action || action === 'list') return { handled: true, value: pluginList(options) };
    if (action === 'enable') return { handled: true, value: pluginEnable(options, positional.slice(1)) };
    if (action === 'disable') return { handled: true, value: pluginDisable(options, positional.slice(1)) };
    throw new Error(`Unknown plugin command: ${action}`);
  }
  if (command === 'tool') {
    if (!action || action === 'list') return { handled: true, value: await toolList(options) };
    if (action === 'call') return { handled: true, value: await toolCall(options, positional.slice(1)) };
    throw new Error(`Unknown tool command: ${action}`);
  }
  if (command === 'job') return { handled: true, value: await jobCommand(action || 'list', options, positional.slice(1)) };
  if (command === 'runner' && (!action || action === 'status')) {
    return { handled: true, value: await toolCall({ ...options, name: 'runner_status', args: json(options.workspace ? { workspaceId: options.workspace } : {}) }) };
  }
  return { handled: false, value: null };
}

export async function runShell(dispatch, { prompt = 'devmate> ', inputStream = input, outputStream = output } = {}) {
  const rl = readline.createInterface({ input: inputStream, output: outputStream, terminal: !!outputStream.isTTY });
  outputStream.write('DevMate interactive shell. Type help or exit.\n');
  try {
    while (true) {
      let line;
      try { line = await rl.question(prompt); }
      catch { break; }
      const words = shellWords(line);
      if (!words.length) continue;
      const command = words[0].toLowerCase();
      if (command === 'exit' || command === 'quit') break;
      try { await dispatch(words); }
      catch (error) { outputStream.write(`DevMate: ${error?.message || error}\n`); }
    }
  } finally {
    rl.close();
  }
}

export function extendedHelp() {
  return `\nCLI-first commands\n\n  devmate                     Enter interactive shell\n  devmate shell               Enter interactive shell\n  devmate start|stop|restart  Manage a background standalone Gateway owned by this CLI\n  devmate runtime-status      Show background Gateway ownership and health\n\n  devmate workspace list\n  devmate workspace add <path> [--use]\n  devmate workspace use <id|path>\n  devmate workspace remove <id>\n\n  devmate plugin list\n  devmate plugin enable <id>\n  devmate plugin disable <id> [--cascade]\n\n  devmate tool list\n  devmate tool call <name> --args '{"key":"value"}'\n  devmate job list [--status <status>] [--workspace <id>]\n  devmate job status|artifacts|cancel|retry <id>\n  devmate runner status [--workspace <id>]\n`;
}

export const __test = {
  booleanOption,
  boundedInteger,
  dependencyClosure,
  parseJsonArgs,
  shellWords,
  workspaceAdd,
  workspaceList,
  workspaceRemove,
  workspaceUse
};
