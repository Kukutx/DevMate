import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeSlash,
  readConfig,
  redactSensitiveString,
  redactSensitiveValue,
  toolText
} from './local-shared.mjs';
import { registerToolDecorator } from './server-extension-host.mjs';
import {
  isSafeWorkspaceTextPath,
  isSensitiveWorkspacePath,
  sensitiveWorkspacePathReason
} from './sensitive-path-policy.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

const MAX_SEARCH_FILE_BYTES = 1024 * 1024;
const MAX_SEARCH_FILES = 10_000;
const MAX_DIRECTORY_SCAN_ENTRIES = 20_000;
const MUTATION_TOOLS = new Set(['write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup']);
const RESULT_PATH_FILTER_TOOLS = new Set([
  'workspace_map', 'list_files', 'project_snapshot', 'project_instructions',
  'vscode_context', 'active_editor_context', 'list_diagnostics',
  'connection_diagnostics', 'devmate_status_panel'
]);

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function workspacePublic(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role || (workspace.reference ? 'reference' : 'active'),
    mode: workspace.mode || (workspace.reference ? 'readonly' : 'workspace-write'),
    reference: !!workspace.reference,
    writable: !workspace.reference && (workspace.mode || 'workspace-write') !== 'readonly',
    root: path.basename(workspace.root || '')
  };
}

function assertNotSensitive(rel, label = 'Path') {
  const value = String(rel || '').trim();
  if (!value || value === '.') return value;
  const reason = sensitiveWorkspacePathReason(value);
  if (reason) {
    const error = new Error(`${label} is protected by DevMate credential policy: ${rel}`);
    error.code = 'sensitive_workspace_path';
    error.reason = reason;
    throw error;
  }
  return value;
}

function safeWorkspacePath(workspace, rel = '.') {
  const root = path.resolve(workspace.root);
  const full = path.resolve(root, String(rel || '.'));
  if (!isInside(root, full)) throw new Error(`Path escapes workspace root: ${rel}`);
  const rootReal = fs.realpathSync.native(root);
  const direct = fs.lstatSync(full, { throwIfNoEntry: false });
  if (direct?.isSymbolicLink()) throw new Error(`Read blocked: symlink/reparse target: ${rel}`);
  let ancestor = direct?.isDirectory() ? full : path.dirname(full);
  while (!fs.lstatSync(ancestor, { throwIfNoEntry: false }) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  const ancestorReal = fs.realpathSync.native(ancestor);
  if (!isInside(rootReal, ancestorReal)) throw new Error(`Path escapes workspace root through symlink/reparse point: ${rel}`);
  if (direct) {
    const targetReal = fs.realpathSync.native(full);
    if (!isInside(rootReal, targetReal)) throw new Error(`Path escapes workspace root: ${rel}`);
  }
  return full;
}

function workspaceRelative(workspace, full) {
  return normalizeSlash(path.relative(path.resolve(workspace.root), full));
}

async function assertNoSensitiveDescendants(workspace, rel) {
  const full = safeWorkspacePath(workspace, rel);
  const rootStat = await fsp.lstat(full).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) return;
  let count = 0;
  const scan = async directory => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const childRel = workspaceRelative(workspace, child);
      if (isSensitiveWorkspacePath(childRel)) {
        const error = new Error(`Directory mutation blocked because it contains a protected credential path: ${childRel}`);
        error.code = 'sensitive_workspace_path';
        error.reason = sensitiveWorkspacePathReason(childRel);
        throw error;
      }
      count += 1;
      if (count > MAX_DIRECTORY_SCAN_ENTRIES) {
        const error = new Error(`Directory mutation credential scan exceeds ${MAX_DIRECTORY_SCAN_ENTRIES} entries`);
        error.code = 'sensitive_workspace_scan_limit';
        throw error;
      }
      if (!entry.isDirectory()) continue;
      const stat = await fsp.lstat(child).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      await scan(child);
    }
  };
  await scan(full);
}

function restoreTargetRelative(args = {}) {
  if (args.targetPath) return String(args.targetPath);
  const configPath = String(process.env.DEVMATE_CONFIG || '').trim();
  const backupPath = String(args.backupPath || '').trim();
  if (!configPath || !backupPath) return '';
  const backupRoot = path.join(path.dirname(path.resolve(configPath)), 'state', 'backups');
  const full = path.resolve(backupPath);
  if (!isInside(backupRoot, full)) return '';
  const parts = path.relative(backupRoot, full).split(path.sep).filter(Boolean);
  return parts.length >= 2 ? normalizeSlash(parts.slice(1).join('/')) : '';
}

function guardExplicitPaths(name, args = {}) {
  if (['write_file', 'create_file', 'delete_file'].includes(name)) assertNotSensitive(args.path, 'Target path');
  if (name === 'apply_patch') assertNotSensitive(args.path || args.filePath, 'Target path');
  if (name === 'move_file') {
    assertNotSensitive(args.from, 'Source path');
    assertNotSensitive(args.to, 'Destination path');
  }
  if (name === 'restore_backup') assertNotSensitive(restoreTargetRelative(args), 'Restore target');
  if (name === 'read_file') assertNotSensitive(args.path || args.filePath, 'Read path');
  if (['list_files', 'search_text', 'list_project_scripts'].includes(name)) assertNotSensitive(args.subpath || '.', 'Read path');
}

async function guardMutationTree(name, args = {}) {
  if (!MUTATION_TOOLS.has(name)) return;
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  if (name === 'delete_file' && args.path) await assertNoSensitiveDescendants(workspace, args.path);
  if (name === 'move_file') {
    if (args.from) await assertNoSensitiveDescendants(workspace, args.from);
    if (args.to) {
      const target = safeWorkspacePath(workspace, args.to);
      const stat = await fsp.lstat(target).catch(() => null);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await assertNoSensitiveDescendants(workspace, args.to);
    }
  }
}

async function safeSearchText(args = {}) {
  const { workspaceId, query, subpath = '.', regex = false } = args;
  const search = String(query || '');
  if (!search) throw new Error('query is required');
  const maxResults = Math.min(500, Math.max(1, Number(args.maxResults) || 120));
  guardExplicitPaths('search_text', args);
  const config = readConfig();
  const workspace = resolveWorkspace(config, workspaceId);
  const root = safeWorkspacePath(workspace, subpath);
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('search_text subpath must be a real directory');
  let pattern = null;
  if (regex) {
    try { pattern = new RegExp(search); }
    catch (error) { throw new Error(`Invalid regex: ${error.message}`); }
  }
  const literal = search.toLowerCase();
  const files = [];
  const walk = async directory => {
    if (files.length >= MAX_SEARCH_FILES) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= MAX_SEARCH_FILES) break;
      const child = path.join(directory, entry.name);
      const rel = workspaceRelative(workspace, child);
      if (isSensitiveWorkspacePath(rel)) continue;
      const stat = await fsp.lstat(child).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(child);
      } else if (stat.isFile() && stat.size <= MAX_SEARCH_FILE_BYTES && isSafeWorkspaceTextPath(rel)) {
        files.push({ full: child, rel });
      }
    }
  };
  await walk(root);

  const results = [];
  for (const file of files) {
    if (results.length >= maxResults) break;
    const text = await fsp.readFile(file.full, 'utf8').catch(() => null);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (pattern) pattern.lastIndex = 0;
      const matches = pattern ? pattern.test(line) : line.toLowerCase().includes(literal);
      if (!matches) continue;
      results.push({ file: file.rel, line: index + 1, preview: redactSensitiveString(line.trim()).slice(0, 300) });
      if (results.length >= maxResults) break;
    }
  }
  return toolText({ workspace: workspacePublic(workspace), query: search, engine: 'builtin', results });
}

function syncTextContent(result) {
  if (!result?.structuredContent || !Array.isArray(result.content)) return result;
  const text = JSON.stringify(result.structuredContent, null, 2);
  for (const item of result.content) if (item?.type === 'text') item.text = text;
  return result;
}

function safePathEntry(item) {
  if (!item || typeof item !== 'object') return true;
  for (const key of ['path', 'file']) {
    if (typeof item[key] === 'string' && isSensitiveWorkspacePath(item[key])) return false;
  }
  return true;
}

function filterPathResults(name, result) {
  const data = result?.structuredContent;
  if (!data || typeof data !== 'object') return result;
  if (['workspace_map', 'list_files'].includes(name) && Array.isArray(data.items)) {
    data.items = data.items.filter(safePathEntry);
  }
  if (name === 'project_snapshot') {
    if (Array.isArray(data.tree)) data.tree = data.tree.filter(safePathEntry);
    if (Array.isArray(data.instructions?.available)) data.instructions.available = data.instructions.available.filter(safePathEntry);
    if (Array.isArray(data.instructions?.loaded)) data.instructions.loaded = data.instructions.loaded.filter(safePathEntry);
  }
  if (name === 'project_instructions') {
    if (Array.isArray(data.instructions?.available)) data.instructions.available = data.instructions.available.filter(safePathEntry);
    if (Array.isArray(data.instructions?.loaded)) data.instructions.loaded = data.instructions.loaded.filter(safePathEntry);
  }
  if (name === 'vscode_context') {
    if (data.activeEditor && !safePathEntry(data.activeEditor)) data.activeEditor = null;
    if (Array.isArray(data.visibleEditors)) data.visibleEditors = data.visibleEditors.filter(safePathEntry);
    if (Array.isArray(data.diagnostics)) data.diagnostics = data.diagnostics.filter(safePathEntry);
  }
  if (name === 'active_editor_context' && data.activeEditor && !safePathEntry(data.activeEditor)) data.activeEditor = null;
  if (name === 'list_diagnostics' && Array.isArray(data.diagnostics)) {
    data.diagnostics = data.diagnostics.filter(safePathEntry);
    data.total = data.diagnostics.length;
  }
  if (['connection_diagnostics', 'devmate_status_panel'].includes(name) && data.vscode?.activeEditor && !safePathEntry(data.vscode.activeEditor)) {
    data.vscode.activeEditor = null;
  }
  return syncTextContent(result);
}

function redactReadResult(name, result) {
  if (!result?.structuredContent) return result;
  if ([
    'project_snapshot', 'project_instructions', 'list_project_scripts',
    'vscode_context', 'active_editor_context', 'list_diagnostics'
  ].includes(name)) {
    result.structuredContent = redactSensitiveValue(result.structuredContent);
  }
  return syncTextContent(result);
}

export function installFileAccessHardening(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.file-access-hardening',
    order: 6,
    decorate({ name, handler }) {
      if (name === 'search_text') return { handler: safeSearchText };
      return {
        handler: async (args = {}, ...rest) => {
          guardExplicitPaths(name, args);
          await guardMutationTree(name, args);
          let result = await handler(args, ...rest);
          if (RESULT_PATH_FILTER_TOOLS.has(name)) result = filterPathResults(name, result);
          return redactReadResult(name, result);
        }
      };
    }
  });
}

export const __test = {
  MAX_DIRECTORY_SCAN_ENTRIES,
  MAX_SEARCH_FILE_BYTES,
  MAX_SEARCH_FILES,
  RESULT_PATH_FILTER_TOOLS,
  assertNoSensitiveDescendants,
  assertNotSensitive,
  filterPathResults,
  guardExplicitPaths,
  guardMutationTree,
  restoreTargetRelative,
  safePathEntry,
  safeSearchText,
  safeWorkspacePath
};
