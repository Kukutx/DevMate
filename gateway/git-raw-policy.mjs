import path from 'node:path';

const BLOCKED_GLOBAL_FLAGS = new Set([
  '-c',
  '--config-env',
  '--exec-path',
  '--git-dir',
  '--work-tree'
]);

const BLOCKED_COMMANDS = new Set([
  'clone',
  'config',
  'init',
  'worktree'
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
  if (BLOCKED_COMMANDS.has(command)) {
    throw new Error(`git_raw command is not allowed because it can target state outside the current workspace: ${command}`);
  }
  if (command === 'config' || values.includes('--global') || values.includes('--system')) {
    throw new Error('git_raw cannot modify Git configuration outside the current repository');
  }
  return values;
}

export const __test = { BLOCKED_COMMANDS, BLOCKED_GLOBAL_FLAGS, PATH_VALUE_OPTIONS, localPathEscape, pathValueEscapesWorkspace };
