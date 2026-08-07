
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
  const real = fs.realpathSync.native(path.resolve(String(root || '.')));
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
  localDirectory = '',
  shared = true,
  homeDirectory = os.homedir()
} = {}) {
  const override = expandHome(overrideDirectory, homeDirectory);
  if (override) return path.resolve(override);
  if (shared) return defaultSharedStateDirectory(workspaceRoot, { homeDirectory });
  if (localDirectory) return path.resolve(localDirectory);
  if (!workspaceRoot) throw new Error('A workspace root or local state directory is required');
  return path.join(path.resolve(workspaceRoot), '.devmate');
}

module.exports = {
  defaultSharedStateDirectory,
  expandHome,
  normalizedWorkspaceRoot,
  resolveStateDirectory,
  workspaceRuntimeId
};
