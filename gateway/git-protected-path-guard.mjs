import fs from 'node:fs';
import path from 'node:path';
import { executeCommand } from './command-process.mjs';
import { readConfig } from './local-shared.mjs';
import { registerToolDecorator } from './server-extension-host.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

const HIDDEN_DIRS = new Set([
  '.git', '.godot', 'node_modules', '.next', '.dart_tool', '.firebase', 'build', 'dist',
  'coverage', 'bin', 'obj', '.venv', 'venv', 'secrets', 'secret', 'credentials',
  'credential', 'private-key', 'private_keys', 'service-account', 'service_accounts'
]);
const BLOCKED_EXT = new Set(['.pem', '.key', '.pfx', '.p12', '.db', '.sqlite', '.sqlite3', '.log']);
const BLOCKED_BASENAME = new Set([
  'credentials.json', 'credential.json', 'secrets.json', 'secret.json',
  'service-account.json', 'service_account.json', 'service-account-key.json',
  'service_account_key.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);
const GUARDED_TOOLS = new Set([
  'git_diff', 'show_changes', 'git_blame', 'git_add', 'git_stage', 'git_commit', 'git_save'
]);
const MAX_PREFLIGHT_OUTPUT = 2 * 1024 * 1024;

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function relParts(value) {
  return normalizeSlash(value).split('/').filter(Boolean);
}

function isEnvFile(base) {
  const value = String(base || '').toLowerCase();
  return value === '.env' || value.startsWith('.env.') || value === 'env.local' || value.endsWith('.env');
}

function isEnvExample(base) {
  const value = String(base || '').toLowerCase();
  return value === '.env.example' || value === '.env.sample' || value.endsWith('.env.example') || value.endsWith('.env.sample');
}

export function isProtectedGitPath(value) {
  const normalized = path.posix.normalize(normalizeSlash(value || '.'));
  const parts = relParts(normalized).map(part => part.toLowerCase());
  if (parts.some(part => HIDDEN_DIRS.has(part))) return true;
  const base = path.posix.basename(normalized).toLowerCase();
  if (BLOCKED_BASENAME.has(base)) return true;
  if (isEnvFile(base) && !isEnvExample(base)) return true;
  return BLOCKED_EXT.has(path.posix.extname(base).toLowerCase());
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function resolvedTargetRel(workspace, relativePath) {
  const root = path.resolve(workspace.root);
  const rootReal = fs.realpathSync.native(root);
  const requested = path.resolve(root, String(relativePath || '.'));
  if (!isInside(root, requested)) return null;

  let existing = requested;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  let existingReal;
  try { existingReal = fs.realpathSync.native(existing); }
  catch { return normalizeSlash(path.relative(root, requested)); }
  const resolved = path.resolve(existingReal, path.relative(existing, requested));
  if (!isInside(rootReal, resolved)) return null;
  return normalizeSlash(path.relative(rootReal, resolved));
}

function pathIsProtected(workspace, relativePath) {
  if (isProtectedGitPath(relativePath)) return true;
  const targetRel = resolvedTargetRel(workspace, relativePath);
  return targetRel == null || isProtectedGitPath(targetRel);
}

function parseNulList(value) {
  return String(value || '').split('\0').filter(Boolean);
}

async function gitNameList(workspace, args) {
  const result = await executeCommand('git', args, {
    cwd: workspace.root,
    shell: false,
    timeoutMs: 30000,
    maxOutputChars: MAX_PREFLIGHT_OUTPUT
  });
  if (result.exitCode !== 0 || result.timedOut || result.signal || result.error || result.exitConfirmed === false) {
    throw new Error('Git protected-path preflight failed');
  }
  if (result.stdoutTruncated) throw new Error('Git protected-path preflight exceeded its safety limit');
  return parseNulList(result.stdout);
}

async function assertNoProtected(workspace, paths, action) {
  let count = 0;
  for (const candidate of new Set(paths.map(normalizeSlash))) {
    if (pathIsProtected(workspace, candidate)) count += 1;
  }
  if (count > 0) {
    const error = new Error(`${action} blocked because it includes ${count} protected path${count === 1 ? '' : 's'}. Use explicit safe paths and keep secrets outside Git operations.`);
    error.code = 'protected_git_path';
    error.protectedPathCount = count;
    throw error;
  }
}

async function assertPathspecSafe(workspace, pathspecs, action) {
  if (!Array.isArray(pathspecs) || pathspecs.length === 0) return;
  await assertNoProtected(workspace, pathspecs, action);
  const matched = await gitNameList(workspace, ['ls-files', '-c', '-o', '--exclude-standard', '-z', '--', ...pathspecs]);
  await assertNoProtected(workspace, matched, action);
}

async function unstagedPaths(workspace) {
  return gitNameList(workspace, ['diff', '--name-only', '-z']);
}

async function stagedPaths(workspace) {
  return gitNameList(workspace, ['diff', '--cached', '--name-only', '-z']);
}

async function allChangedPaths(workspace) {
  const [unstaged, staged, untracked] = await Promise.all([
    unstagedPaths(workspace),
    stagedPaths(workspace),
    gitNameList(workspace, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]);
  return [...new Set([...unstaged, ...staged, ...untracked])];
}

export async function assertStructuredGitProtectedPaths(name, args, workspace) {
  if (!GUARDED_TOOLS.has(name)) return;
  const input = args || {};

  if (name === 'git_blame') {
    await assertNoProtected(workspace, [input.path], 'Git blame');
    return;
  }

  if (name === 'git_diff') {
    if (Array.isArray(input.paths) && input.paths.length) {
      await assertPathspecSafe(workspace, input.paths, 'Git diff');
      return;
    }
    const changed = input.staged ? await stagedPaths(workspace) : await unstagedPaths(workspace);
    await assertNoProtected(workspace, changed, 'Git diff');
    return;
  }

  if (name === 'show_changes') {
    const changed = input.staged ? await stagedPaths(workspace) : await unstagedPaths(workspace);
    await assertNoProtected(workspace, changed, 'Change review');
    return;
  }

  if (name === 'git_add' || name === 'git_stage') {
    if (Array.isArray(input.paths) && input.paths.length) {
      await assertPathspecSafe(workspace, input.paths, 'Git staging');
    } else {
      await assertNoProtected(workspace, await allChangedPaths(workspace), 'Git staging');
    }
    return;
  }

  if (name === 'git_commit') {
    if (input.all === true) await assertNoProtected(workspace, await allChangedPaths(workspace), 'Git commit');
    await assertNoProtected(workspace, await stagedPaths(workspace), 'Git commit');
    return;
  }

  if (name === 'git_save') {
    const explicitPaths = Array.isArray(input.paths) ? input.paths : [];
    if (explicitPaths.length) {
      await assertPathspecSafe(workspace, explicitPaths, 'Git save');
    } else if (input.all !== false) {
      await assertNoProtected(workspace, await allChangedPaths(workspace), 'Git save');
    }
    await assertNoProtected(workspace, await stagedPaths(workspace), 'Git save');
  }
}

export function installGitProtectedPathGuard(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.git-protected-paths',
    order: 5,
    decorate({ name, handler }) {
      if (!GUARDED_TOOLS.has(name)) return { handler };
      return {
        handler: async (args = {}, ...rest) => {
          const workspace = resolveWorkspace(readConfig(), args.workspaceId);
          await assertStructuredGitProtectedPaths(name, args, workspace);
          return handler(args, ...rest);
        }
      };
    }
  });
}

export const __test = {
  GUARDED_TOOLS,
  allChangedPaths,
  assertNoProtected,
  assertPathspecSafe,
  pathIsProtected,
  resolvedTargetRel,
  stagedPaths,
  unstagedPaths
};
