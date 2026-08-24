import path from 'node:path';
import { executeCommand } from './command-process.mjs';
import { readConfig } from './local-shared.mjs';
import { registerToolDecorator } from './server-extension-host.mjs';
import { isSensitiveWorkspacePath, sensitiveWorkspacePathReason } from './sensitive-path-policy.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

const MAX_GIT_PATH_OUTPUT = 2 * 1024 * 1024;
const MAX_SAFE_DIFF_PATHS = 128;
const MAX_SAFE_DIFF_ARGUMENT_CHARS = 16 * 1024;
const SAFE_RAW = new Set(['status', 'branch', 'rev-parse', 'describe', 'tag', 'ls-files']);
const STATUS_RESULT_TOOLS = new Set(['git_add', 'git_stage', 'git_commit', 'git_save']);

function protectedError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function assertSafePath(value, label = 'Git path') {
  const rel = String(value || '').trim();
  if (!rel || rel === '.') return rel;
  const reason = sensitiveWorkspacePathReason(rel);
  if (reason) throw protectedError(`${label} is protected by DevMate credential policy: ${rel}`, 'sensitive_workspace_path', { reason });
  return rel;
}

async function runGit(workspace, args, maxOutputChars = MAX_GIT_PATH_OUTPUT) {
  const result = await executeCommand('git', args, {
    cwd: workspace.root,
    shell: false,
    timeoutMs: 60_000,
    maxOutputChars
  });
  if (
    result.exitCode !== 0 || result.timedOut || result.error || result.signal ||
    result.exitConfirmed === false || result.stdoutTruncated
  ) {
    throw protectedError('Git protected-path preflight failed', 'git_sensitive_path_probe_failed');
  }
  return result;
}

function nulPaths(stdout = '') {
  return String(stdout).split('\0').filter(Boolean).map(value => value.replace(/\\/g, '/'));
}

async function diffPaths(workspace, staged = false) {
  const args = ['diff'];
  if (staged) args.push('--staged');
  args.push('--name-only', '-z');
  return nulPaths((await runGit(workspace, args)).stdout);
}

async function stagedSensitivePaths(workspace) {
  return (await diffPaths(workspace, true)).filter(isSensitiveWorkspacePath);
}

async function preflightDiffScale(name, args = {}) {
  if (!['git_diff', 'git_staged_files', 'show_changes'].includes(name)) return;
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const staged = name === 'git_staged_files' || args.staged === true;
  const safe = (await diffPaths(workspace, staged)).filter(rel => !isSensitiveWorkspacePath(rel));
  const chars = safe.reduce((sum, rel) => sum + rel.length + 1, 0);
  if (safe.length > MAX_SAFE_DIFF_PATHS || chars > MAX_SAFE_DIFF_ARGUMENT_CHARS) {
    throw protectedError(
      `Protected Git review exceeds the bounded safe-path set (${safe.length} paths, ${chars} characters)`,
      'git_safe_diff_path_limit',
      { safePathCount: safe.length, argumentChars: chars }
    );
  }
}

async function preflightCommitBoundary(name, args = {}) {
  if (!['git_commit', 'git_save'].includes(name)) return;
  const config = readConfig();
  const workspace = resolveWorkspace(config, args.workspaceId);
  const blocked = await stagedSensitivePaths(workspace);
  if (blocked.length) {
    throw protectedError(
      `Git commit blocked because ${blocked.length} protected credential path(s) are staged`,
      'git_sensitive_path_commit_blocked',
      { blockedCount: blocked.length }
    );
  }
}

function rawCommand(args = []) {
  const values = Array.isArray(args) ? args.map(value => String(value || '').trim()).filter(Boolean) : [];
  return { values, command: String(values[0] || '').toLowerCase() };
}

function guardRaw(args = {}) {
  const parsed = rawCommand(args.args);
  if (!parsed.command || !SAFE_RAW.has(parsed.command)) {
    throw protectedError(
      `git_raw is limited to metadata-only commands: ${[...SAFE_RAW].join(', ')}`,
      'git_raw_command_restricted'
    );
  }
  if (['branch', 'tag'].includes(parsed.command)) {
    const positional = parsed.values.slice(1).filter(value => !value.startsWith('-'));
    if (positional.length) {
      throw protectedError(`git_raw ${parsed.command} cannot accept positional mutation arguments`, 'git_raw_mutation_restricted');
    }
  }
  if (['status', 'ls-files'].includes(parsed.command)) {
    for (const value of parsed.values.slice(1)) {
      if (!value.startsWith('-') && value !== '--') assertSafePath(value, 'Git raw path');
    }
  }
  return parsed;
}

function statusPath(line) {
  const text = String(line || '');
  if (!text || text.startsWith('## ')) return '';
  const raw = text.length >= 3 ? text.slice(3).trim() : text.trim();
  const arrow = raw.lastIndexOf(' -> ');
  return (arrow >= 0 ? raw.slice(arrow + 4) : raw).replace(/^"|"$/g, '');
}

function filterStatus(value) {
  let removed = 0;
  const text = String(value || '').split(/\r?\n/).filter(line => {
    const rel = statusPath(line);
    const blocked = !!rel && isSensitiveWorkspacePath(rel);
    if (blocked) removed += 1;
    return !blocked;
  }).join('\n');
  return { text, removed };
}

function filterLinePaths(value) {
  return String(value || '').split(/\r?\n/).filter(line => {
    const fields = line.split(/\s+/).filter(Boolean);
    return !isSensitiveWorkspacePath(fields.at(-1) || '');
  }).join('\n');
}

function syncText(result) {
  if (!result?.structuredContent || !Array.isArray(result.content)) return result;
  const value = JSON.stringify(result.structuredContent, null, 2);
  for (const item of result.content) if (item?.type === 'text') item.text = value;
  return result;
}

function filterProjectSnapshot(result) {
  const git = result?.structuredContent?.git;
  if (!git) return result;
  const filtered = filterStatus(git.status?.stdout);
  if (git.status && typeof git.status.stdout === 'string') git.status.stdout = filtered.text;
  if (filtered.removed > 0 && git.diffStat && typeof git.diffStat.stdout === 'string') {
    git.diffStat.stdout = '';
    git.diffStat.sensitivePathsOmitted = filtered.removed;
  }
  return syncText(result);
}

function filterStatusResult(result) {
  const status = result?.structuredContent?.status;
  if (!status || typeof status.stdout !== 'string') return result;
  const filtered = filterStatus(status.stdout);
  status.stdout = filtered.text;
  if (filtered.removed) status.sensitivePathsOmitted = filtered.removed;
  return syncText(result);
}

function filterRawResult(args, result) {
  const command = rawCommand(args.args).command;
  const data = result?.structuredContent;
  if (!data || typeof data.stdout !== 'string') return result;
  if (command === 'status') data.stdout = filterStatus(data.stdout).text;
  if (command === 'ls-files') data.stdout = filterLinePaths(data.stdout);
  return syncText(result);
}

function guardExplicitGitPaths(name, args = {}) {
  if (name === 'git_blame') assertSafePath(args.path);
  if (name === 'git_diff' && Array.isArray(args.paths)) args.paths.forEach(value => assertSafePath(value));
  if (['git_add', 'git_stage', 'git_save'].includes(name) && Array.isArray(args.paths)) args.paths.forEach(value => assertSafePath(value));
}

export function installGitAccessGuard(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.git-access-guard',
    order: 7,
    decorate({ name, handler }) {
      return {
        handler: async (args = {}, ...rest) => {
          guardExplicitGitPaths(name, args);
          if (name === 'git_raw') guardRaw(args);
          await preflightDiffScale(name, args);
          await preflightCommitBoundary(name, args);
          let result = await handler(args, ...rest);
          if (name === 'project_snapshot') result = filterProjectSnapshot(result);
          if (STATUS_RESULT_TOOLS.has(name)) result = filterStatusResult(result);
          if (name === 'git_raw') result = filterRawResult(args, result);
          return result;
        }
      };
    }
  });
}

export const __test = {
  MAX_SAFE_DIFF_ARGUMENT_CHARS,
  MAX_SAFE_DIFF_PATHS,
  SAFE_RAW,
  assertSafePath,
  filterLinePaths,
  filterProjectSnapshot,
  filterRawResult,
  filterStatus,
  filterStatusResult,
  guardExplicitGitPaths,
  guardRaw,
  preflightCommitBoundary,
  preflightDiffScale,
  rawCommand,
  stagedSensitivePaths,
  statusPath
};
