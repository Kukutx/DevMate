import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { executeCommand } from './command-process.mjs';
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
const MAX_GIT_PATH_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_GIT_OUTPUT = 120_000;
const DEFAULT_GIT_TIMEOUT_MS = 180_000;
const MUTATION_TOOLS = new Set(['write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup']);
const RESULT_PATH_FILTER_TOOLS = new Set([
  'workspace_map', 'list_files', 'project_snapshot', 'project_instructions',
  'vscode_context', 'active_editor_context', 'list_diagnostics',
  'connection_diagnostics', 'devmate_status_panel'
]);
const SAFE_GIT_RAW_COMMANDS = new Set(['status', 'branch', 'rev-parse', 'describe', 'tag', 'ls-files']);

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

function normalizeWorkspaceRel(workspace, rel = '.') {
  const root = path.resolve(workspace.root);
  const full = path.resolve(root, String(rel || '.'));
  if (!isInside(root, full)) throw new Error(`Path escapes workspace root: ${rel}`);
  return normalizeSlash(path.relative(root, full)) || '.';
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
  return String(args.targetPath || args.entryPath || '');
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
  if (name === 'git_blame') assertNotSensitive(args.path, 'Git path');
  if (['git_diff', 'git_add', 'git_stage', 'git_save'].includes(name) && Array.isArray(args.paths)) {
    for (const rel of args.paths) assertNotSensitive(rel, 'Git path');
  }
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

async function runGit(workspace, args, maxOutputChars = DEFAULT_GIT_OUTPUT, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
  return executeCommand('git', args, {
    cwd: workspace.root,
    maxOutputChars,
    timeoutMs,
    shell: false
  });
}

function assertGitProbe(result, label) {
  if (!result || result.exitCode !== 0 || result.timedOut || result.error || result.signal || result.exitConfirmed === false) {
    const error = new Error(`${label} failed while enforcing protected-path policy`);
    error.code = 'git_sensitive_path_probe_failed';
    throw error;
  }
  if (result.stdoutTruncated) {
    const error = new Error(`${label} exceeded the protected-path inspection bound`);
    error.code = 'git_sensitive_path_probe_truncated';
    throw error;
  }
  return result;
}

function nulPaths(output) {
  return String(output || '').split('\0').filter(Boolean).map(normalizeSlash);
}

async function gitNameOnly(workspace, { staged = false, paths = [] } = {}) {
  const args = ['diff'];
  if (staged) args.push('--staged');
  args.push('--name-only', '-z');
  if (paths.length) args.push('--', ...paths);
  const result = assertGitProbe(await runGit(workspace, args, MAX_GIT_PATH_OUTPUT), 'git diff --name-only');
  return nulPaths(result.stdout);
}

async function changedSensitivePaths(workspace) {
  const [unstaged, staged, untracked] = await Promise.all([
    runGit(workspace, ['diff', '--name-only', '-z'], MAX_GIT_PATH_OUTPUT),
    runGit(workspace, ['diff', '--staged', '--name-only', '-z'], MAX_GIT_PATH_OUTPUT),
    runGit(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], MAX_GIT_PATH_OUTPUT)
  ]);
  const all = [
    ...nulPaths(assertGitProbe(unstaged, 'git unstaged path probe').stdout),
    ...nulPaths(assertGitProbe(staged, 'git staged path probe').stdout),
    ...nulPaths(assertGitProbe(untracked, 'git untracked path probe').stdout)
  ];
  return [...new Set(all.filter(isSensitiveWorkspacePath))];
}

function scopeContains(scope, rel) {
  const cleanScope = normalizeSlash(scope || '.').replace(/^\.\//, '').replace(/\/$/, '');
  const cleanRel = normalizeSlash(rel || '').replace(/^\.\//, '');
  return !cleanScope || cleanScope === '.' || cleanRel === cleanScope || cleanRel.startsWith(`${cleanScope}/`);
}

async function guardGitStaging(name, args = {}) {
  const broadStage =
    (['git_add', 'git_stage'].includes(name) && (!Array.isArray(args.paths) || args.paths.length === 0)) ||
    (name === 'git_commit' && args.all === true) ||
    (name === 'git_save' && (!Array.isArray(args.paths) || args.paths.length === 0) && args.all !== false);
  const explicitStage = ['git_add', 'git_stage', 'git_save'].includes(name) && Array.isArray(args.paths) && args.paths.length > 0;
  if (!broadStage && !explicitStage) return;

  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const sensitive = await changedSensitivePaths(workspace);
  const scopes = broadStage ? ['.'] : args.paths.map(rel => normalizeWorkspaceRel(workspace, rel));
  const blocked = sensitive.filter(rel => scopes.some(scope => scopeContains(scope, rel)));
  if (blocked.length) {
    const error = new Error(`Git staging blocked because ${blocked.length} protected credential path(s) would be included`);
    error.code = 'git_sensitive_path_staging_blocked';
    error.blockedCount = blocked.length;
    throw error;
  }
}

function emptyGitResult(workspace, args) {
  return {
    command: ['git', ...args].join(' '),
    cwd: workspace.root,
    exitCode: 0,
    signal: null,
    error: undefined,
    timedOut: false,
    terminated: false,
    forced: false,
    exitConfirmed: true,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false
  };
}

async function safeGitDiff(args = {}) {
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const requested = (Array.isArray(args.paths) ? args.paths : []).map(rel => normalizeWorkspaceRel(workspace, rel));
  const changed = await gitNameOnly(workspace, { staged: args.staged === true, paths: requested });
  const safePaths = changed.filter(rel => !isSensitiveWorkspacePath(rel));
  const diffArgs = ['diff'];
  if (args.staged === true) diffArgs.push('--staged');
  if (!safePaths.length) return toolText({ workspace: workspacePublic(workspace), ...emptyGitResult(workspace, diffArgs) });
  diffArgs.push('--', ...safePaths);
  const maxOutput = Math.min(500_000, Math.max(1000, Number(args.maxOutputChars) || DEFAULT_GIT_OUTPUT));
  return toolText({ workspace: workspacePublic(workspace), ...(await runGit(workspace, diffArgs, maxOutput)) });
}

function parseNumstat(stdout = '') {
  const files = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, remove, ...rest] = parts;
    const file = rest.join('\t');
    if (isSensitiveWorkspacePath(file)) continue;
    files.push({
      path: file,
      additions: add === '-' ? null : Number(add) || 0,
      removals: remove === '-' ? null : Number(remove) || 0
    });
  }
  return files;
}

function changeSummary(files = []) {
  let additions = 0;
  let removals = 0;
  let binaryFiles = 0;
  for (const file of files) {
    if (typeof file.additions === 'number') additions += file.additions;
    else binaryFiles += 1;
    if (typeof file.removals === 'number') removals += file.removals;
  }
  return { filesChanged: files.length, additions, removals, binaryFiles };
}

function statusPathFromLine(line) {
  const text = String(line || '');
  if (text.startsWith('## ')) return '';
  const raw = text.length >= 3 ? text.slice(3).trim() : text.trim();
  const arrow = raw.lastIndexOf(' -> ');
  return arrow >= 0 ? raw.slice(arrow + 4).replace(/^"|"$/g, '') : raw.replace(/^"|"$/g, '');
}

function filterGitStatusText(value) {
  return String(value || '').split(/\r?\n/)
    .filter(line => {
      const rel = statusPathFromLine(line);
      return !rel || !isSensitiveWorkspacePath(rel);
    })
    .join('\n');
}

async function safeGitStatus(args = {}) {
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const gitArgs = args.porcelain === true ? ['status', '--porcelain=v1', '--branch'] : ['status', '--short', '--branch'];
  const result = await runGit(workspace, gitArgs);
  result.stdout = filterGitStatusText(result.stdout);
  return toolText({ workspace: workspacePublic(workspace), ...result });
}

async function safeShowChanges(args = {}) {
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const staged = args.staged === true;
  const safePaths = (await gitNameOnly(workspace, { staged })).filter(rel => !isSensitiveWorkspacePath(rel));
  const statusResult = await runGit(workspace, ['status', '--short', '--branch'], 20_000);
  statusResult.stdout = filterGitStatusText(statusResult.stdout);
  const base = ['diff'];
  if (staged) base.push('--staged');
  if (!safePaths.length) {
    const empty = emptyGitResult(workspace, base);
    return toolText({
      workspace: workspacePublic(workspace), staged, status: statusResult,
      diffStat: { ...empty }, summary: changeSummary([]), files: [], patch: { ...empty }
    });
  }
  const scope = ['--', ...safePaths];
  const maxOutput = Math.min(300_000, Math.max(1000, Number(args.maxOutputChars) || 80_000));
  const [diffStat, numstat, patch] = await Promise.all([
    runGit(workspace, [...base, '--stat', ...scope], 20_000),
    runGit(workspace, [...base, '--numstat', ...scope], 50_000),
    runGit(workspace, [...base, ...scope], maxOutput)
  ]);
  const files = parseNumstat(numstat.stdout);
  return toolText({ workspace: workspacePublic(workspace), staged, status: statusResult, diffStat, summary: changeSummary(files), files, patch });
}

async function safeGitStagedFiles(args = {}) {
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const safePaths = (await gitNameOnly(workspace, { staged: true })).filter(rel => !isSensitiveWorkspacePath(rel));
  const gitArgs = ['diff', '--staged', '--name-status'];
  const result = safePaths.length ? await runGit(workspace, [...gitArgs, '--', ...safePaths]) : emptyGitResult(workspace, gitArgs);
  return toolText({ workspace: workspacePublic(workspace), ...result });
}

function rawGitCommand(args = []) {
  const values = Array.isArray(args) ? args.map(value => String(value || '').trim()).filter(Boolean) : [];
  const index = values.findIndex(value => !value.startsWith('-'));
  return { values, index, command: index >= 0 ? values[index].toLowerCase() : '' };
}

function guardGitRaw(args = {}) {
  const parsed = rawGitCommand(args.args);
  if (!parsed.command || !SAFE_GIT_RAW_COMMANDS.has(parsed.command)) {
    const error = new Error(`git_raw is limited to metadata-only commands: ${[...SAFE_GIT_RAW_COMMANDS].join(', ')}`);
    error.code = 'git_raw_command_restricted';
    throw error;
  }
  if (['status', 'ls-files'].includes(parsed.command)) {
    for (const value of parsed.values.slice(parsed.index + 1)) {
      if (!value.startsWith('-')) assertNotSensitive(value, 'Git raw path');
    }
  }
  return parsed;
}

function filterLinePaths(value) {
  return String(value || '').split(/\r?\n/)
    .filter(line => {
      const fields = line.split(/\s+/).filter(Boolean);
      const rel = fields.at(-1) || '';
      return !isSensitiveWorkspacePath(rel);
    })
    .join('\n');
}

function filterGitRawResult(args, result) {
  const { command } = rawGitCommand(args.args);
  if (!result?.structuredContent) return result;
  if (command === 'status' && typeof result.structuredContent.stdout === 'string') {
    result.structuredContent.stdout = filterGitStatusText(result.structuredContent.stdout);
  }
  if (command === 'ls-files' && typeof result.structuredContent.stdout === 'string') {
    result.structuredContent.stdout = filterLinePaths(result.structuredContent.stdout);
  }
  return syncTextContent(result);
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
      if (name === 'git_diff') return { handler: safeGitDiff };
      if (name === 'git_status') return { handler: safeGitStatus };
      if (name === 'git_staged_files') return { handler: safeGitStagedFiles };
      if (name === 'show_changes') return { handler: safeShowChanges };
      return {
        handler: async (args = {}, ...rest) => {
          guardExplicitPaths(name, args);
          await guardMutationTree(name, args);
          await guardGitStaging(name, args);
          if (name === 'git_raw') guardGitRaw(args);
          let result = await handler(args, ...rest);
          if (name === 'git_raw') result = filterGitRawResult(args, result);
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
  SAFE_GIT_RAW_COMMANDS,
  assertNoSensitiveDescendants,
  assertNotSensitive,
  changedSensitivePaths,
  filterGitRawResult,
  filterGitStatusText,
  filterPathResults,
  guardExplicitPaths,
  guardGitRaw,
  guardGitStaging,
  guardMutationTree,
  normalizeWorkspaceRel,
  rawGitCommand,
  restoreTargetRelative,
  safeGitDiff,
  safeGitStagedFiles,
  safeGitStatus,
  safePathEntry,
  safeSearchText,
  safeShowChanges,
  safeWorkspacePath,
  scopeContains
};
