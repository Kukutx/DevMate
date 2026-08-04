'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(value, homeDirectory = os.homedir()) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return homeDirectory;
  if (text.startsWith(`~${path.sep}`) || text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(homeDirectory, text.slice(2));
  }
  return text;
}

function normalizedWorkspaceRoot(root) {
  const resolved = path.resolve(String(root || '.'));
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); }
  catch { try { real = fs.realpathSync(resolved); } catch {} }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function workspaceRuntimeId(root) {
  const normalized = normalizedWorkspaceRoot(root);
  const base = path.basename(normalized)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'workspace';
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
  return `${base}-${digest}`;
}

function defaultSharedStateDirectory(root, { homeDirectory = os.homedir() } = {}) {
  if (!root) throw new Error('A workspace root is required to resolve shared DevMate state');
  return path.join(homeDirectory, '.devmate', 'hosts', workspaceRuntimeId(root));
}

function resolveStateDirectory({
  workspaceRoot,
  overrideDirectory = '',
  legacyDirectory = '',
  shared = true,
  homeDirectory = os.homedir()
} = {}) {
  const override = expandHome(overrideDirectory, homeDirectory);
  if (override) return path.resolve(override);
  if (shared && workspaceRoot) return defaultSharedStateDirectory(workspaceRoot, { homeDirectory });
  if (legacyDirectory) return path.resolve(legacyDirectory);
  if (!workspaceRoot) throw new Error('A workspace root or state directory is required');
  return path.join(path.resolve(workspaceRoot), '.devmate-server');
}

function copyDirectory(source, target) {
  const ignored = new Set(['gateway.lock', 'runtime.pid', 'runtime.json']);
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
    filter(candidate) {
      const base = path.basename(candidate);
      return !ignored.has(base) && !base.endsWith('.lock') && !base.endsWith('.tmp') && !base.includes('.replace-');
    }
  });
}

function migrateLegacyState({ legacyDirectory, stateDirectory } = {}) {
  if (!legacyDirectory || !stateDirectory) return { migrated: false, reason: 'missing-directory' };
  const source = path.resolve(legacyDirectory);
  const target = path.resolve(stateDirectory);
  if (source === target) return { migrated: false, reason: 'same-directory' };
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    return { migrated: false, reason: 'legacy-missing' };
  }
  const targetConfig = path.join(target, 'config.json');
  if (fs.existsSync(targetConfig)) return { migrated: false, reason: 'target-config-exists' };
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  copyDirectory(source, target);
  return { migrated: fs.existsSync(targetConfig), reason: 'copied' };
}

module.exports = {
  copyDirectory,
  defaultSharedStateDirectory,
  expandHome,
  migrateLegacyState,
  normalizedWorkspaceRoot,
  resolveStateDirectory,
  workspaceRuntimeId
};
