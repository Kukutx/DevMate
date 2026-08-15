import path from 'node:path';

const BLOCKED_GLOBAL_FLAGS = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree',
  '--unsafe-paths'
]);

const BLOCKED_COMMANDS = new Set([
  'add',
  'archive',
  'blame',
  'bundle',
  'cat-file',
  'checkout-index',
  'clone',
  'commit',
  'config',
  'credential',
  'credential-cache',
  'credential-store',
  'daemon',
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'format-patch',
  'grep',
  'http-push',
  'init',
  'log',
  'merge-file',
  'merge-tree',
  'mv',
  'range-diff',
  'send-pack',
  'shell',
  'show',
  'worktree'
]);

// git_raw is intentionally lower-level than the structured Git tools, but it
// must still invoke a reviewed Git builtin that cannot bypass DevMate's file
// content protections or turn Git aliases into arbitrary command execution.
const ALLOWED_COMMANDS = new Set([
  'am', 'apply', 'bisect', 'branch', 'checkout', 'cherry', 'cherry-pick',
  'describe', 'fetch', 'for-each-ref', 'ls-files', 'ls-remote', 'ls-tree',
  'merge', 'merge-base', 'name-rev', 'notes', 'pull', 'push', 'rebase',
  'reflog', 'remote', 'reset', 'restore', 'revert', 'rev-list', 'rev-parse',
  'rm', 'shortlog', 'show-branch', 'show-ref', 'stash', 'status', 'switch',
  'tag', 'verify-commit', 'verify-tag'
]);

const PATH_VALUE_OPTIONS = Object.freeze([
  '--directory',
  '--output',
  '--output-directory',
  '--prefix'
]);

function pathValueEscapesWorkspace(value) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (!text) return false;
  if (/^file:\/\//i.test(text)) return true;
  if (/^[a-z]:/i.test(text) || text.startsWith('/')) return true;
  const normalized = path.posix.normalize(text);
  return normalized === '..' || normalized.startsWith('../');
}

function localPathEscape(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  if (pathValueEscapesWorkspace(text)) return true;
  const lower = text.toLowerCase();
  for (const option of PATH_VALUE_OPTIONS) {
    const prefix = `${option}=`;
    if (lower.startsWith(prefix)) return pathValueEscapesWorkspace(text.slice(prefix.length));
  }
  if (/^-o.+/i.test(text)) return pathValueEscapesWorkspace(text.slice(2));
  return false;
}

export function assertGitRawWorkspaceBound(args = []) {
  if (!Array.isArray(args) || !args.length) throw new Error('git_raw requires at least one Git argument');
  const values = args.map(value => String(value));
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    const lower = value.toLowerCase();
    if (value === '-C' || value.startsWith('-C') && value.length > 2) {
      throw new Error('git_raw cannot change the Git working directory');
    }
    if (BLOCKED_GLOBAL_FLAGS.has(lower) || [...BLOCKED_GLOBAL_FLAGS].some(flag => lower.startsWith(`${flag}=`))) {
      throw new Error(`git_raw option is not allowed because it can escape the workspace or alter Git execution: ${value}`);
    }
    if (localPathEscape(value)) {
      throw new Error(`git_raw path must stay inside the workspace: ${value}`);
    }
  }
  const command = values.find(value => !value.startsWith('-'))?.toLowerCase() || '';
  if (!command) throw new Error('git_raw requires an explicit Git subcommand');
  if (BLOCKED_COMMANDS.has(command)) {
    throw new Error(`git_raw command is not allowed because it can escape the workspace, expose protected content, or bypass DevMate safety controls: ${command}`);
  }
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new Error(`git_raw command is not in the reviewed builtin allowlist: ${command}`);
  }
  if (values.includes('--global') || values.includes('--system')) {
    throw new Error('git_raw cannot modify Git configuration outside the current repository');
  }
  return values;
}

export const __test = {
  ALLOWED_COMMANDS,
  BLOCKED_COMMANDS,
  BLOCKED_GLOBAL_FLAGS,
  PATH_VALUE_OPTIONS,
  localPathEscape,
  pathValueEscapesWorkspace
};
