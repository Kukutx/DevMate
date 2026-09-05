'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const configStore = require('../shared/config-store.cjs');

// Keep this root-level denylist aligned with gateway/sensitive-path-policy.mjs.
// The Gateway remains the final authority; this prevents the VS Code UI from
// persisting obviously unsafe workspace roots in the first place.
const PROTECTED_ROOT_SEGMENTS = new Set([
  '.git', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.npm', '.m2', '.gradle',
  '.terraform', '.pulumi', '.serverless', '.wrangler', '.direnv', '.devmate', '.devmate-server',
  'secrets', 'secret', 'credentials', 'credential', 'private-key', 'private_keys',
  'service-account', 'service_accounts'
]);

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function workspaceRootKey(value) {
  const root = String(value || '').trim();
  return root ? pathKey(root) : '';
}

function protectedRootReason(value) {
  const parts = path.resolve(String(value || ''))
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map(part => part.toLowerCase());
  const segment = parts.find(part => PROTECTED_ROOT_SEGMENTS.has(part));
  return segment ? `protected-directory:${segment}` : '';
}

function additionalWorkspaceId(root) {
  return `trusted-${crypto.createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 12)}`;
}

function normalizeAdditionalWorkspace(inputRoot, name = '') {
  const raw = String(inputRoot || '').trim();
  if (!raw) throw new Error('Workspace path is required');
  if (!path.isAbsolute(raw)) throw new Error('Additional workspace paths must be absolute');
  const resolved = path.resolve(raw);
  if (pathKey(resolved) === pathKey(path.parse(resolved).root)) {
    throw new Error('Filesystem roots cannot be added as DevMate workspaces');
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`Workspace path is not an existing directory: ${resolved}`);
  const real = fs.realpathSync.native(resolved);
  const reason = protectedRootReason(real);
  if (reason) {
    const error = new Error(`Workspace is inside protected credential/control-plane storage (${reason}): ${real}`);
    error.code = 'protected_workspace_root';
    throw error;
  }
  return {
    id: additionalWorkspaceId(real),
    name: String(name || path.basename(real) || 'workspace').trim(),
    root: real,
    mode: 'workspace-write',
    reference: false,
    role: 'trusted',
    trusted: true
  };
}

function normalizedAdditionalWorkspaces(config) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(config?.trustedWritableRoots) ? config.trustedWritableRoots : []) {
    try {
      const normalized = normalizeAdditionalWorkspace(item?.root || item?.path || item, item?.name || '');
      const key = pathKey(normalized.root);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    } catch {}
  }
  return out;
}

function syncAdditionalWorkspaceEntries(config) {
  config.workspaces = Array.isArray(config.workspaces) ? config.workspaces : [];
  const trusted = normalizedAdditionalWorkspaces(config);
  const trustedKeys = new Set(trusted.map(item => pathKey(item.root)));
  const base = config.workspaces.filter(item => {
    if (!item) return false;
    if (item.trusted === true || item.role === 'trusted') return false;
    const key = workspaceRootKey(item.root);
    return !key || !trustedKeys.has(key);
  });
  config.trustedWritableRoots = trusted.map(({ id, name, root }) => ({ id, name, root }));
  config.workspaces = [...base, ...trusted];
  return config;
}

function permissionProfile(config) {
  return config?.permissions?.profile || (config?.permissions?.readOnly ? 'readOnly' : 'fullAccess');
}

function assertFullAccess(config, action) {
  if (permissionProfile(config) !== 'fullAccess') {
    throw new Error(`${action} requires the fullAccess permission profile`);
  }
}

function currentProject(config) {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  return workspaces.find(item => item?.id === config?.activeWorkspaceId && !item.reference)
    || workspaces.find(item => item && !item.reference && item.role === 'active')
    || null;
}

function publicWorkspace(item) {
  if (!item) return null;
  return {
    id: item.id,
    name: item.name,
    root: item.root,
    mode: item.mode || 'workspace-write',
    role: item.role || 'workspace',
    writable: !item.reference && item.mode !== 'readonly'
  };
}

function workspaceAccessSnapshot(config) {
  syncAdditionalWorkspaceEntries(config);
  return {
    current: publicWorkspace(currentProject(config)),
    additional: normalizedAdditionalWorkspaces(config).map(publicWorkspace),
    references: (config.workspaces || []).filter(item => item?.reference).map(publicWorkspace),
    permissionProfile: permissionProfile(config)
  };
}

function listWorkspaceAccess(configFile) {
  let snapshot = null;
  configStore.updateConfig(configFile, config => {
    syncAdditionalWorkspaceEntries(config);
    snapshot = workspaceAccessSnapshot(config);
    return config;
  });
  return snapshot;
}

function addWorkspaceAccess(configFile, inputRoot, name = '') {
  let result = null;
  configStore.updateConfig(configFile, config => {
    syncAdditionalWorkspaceEntries(config);
    assertFullAccess(config, 'Adding an additional workspace');
    const candidate = normalizeAdditionalWorkspace(inputRoot, name);
    const candidateKey = pathKey(candidate.root);
    const ordinary = (config.workspaces || []).find(item =>
      item && item.trusted !== true && item.role !== 'trusted' && workspaceRootKey(item.root) === candidateKey
    );
    if (ordinary) {
      result = {
        added: false,
        reason: ordinary.reference ? 'already-configured-as-readonly-reference' : 'already-configured-as-current-or-workspace',
        workspace: publicWorkspace(ordinary),
        snapshot: workspaceAccessSnapshot(config)
      };
      return config;
    }
    const trusted = normalizedAdditionalWorkspaces(config);
    const existing = trusted.find(item => pathKey(item.root) === candidateKey);
    if (existing) {
      result = { added: false, reason: 'already-added', workspace: publicWorkspace(existing), snapshot: workspaceAccessSnapshot(config) };
      return config;
    }
    config.trustedWritableRoots = [...trusted, candidate].map(({ id, name: itemName, root }) => ({ id, name: itemName, root }));
    syncAdditionalWorkspaceEntries(config);
    result = { added: true, workspace: publicWorkspace(candidate), snapshot: workspaceAccessSnapshot(config) };
    return config;
  }, { retries: 4 });
  return result;
}

function removeWorkspaceAccess(configFile, { id = '', root = '' } = {}) {
  let result = null;
  configStore.updateConfig(configFile, config => {
    syncAdditionalWorkspaceEntries(config);
    assertFullAccess(config, 'Removing an additional workspace');
    const trusted = normalizedAdditionalWorkspaces(config);
    const target = trusted.find(item => id ? item.id === id : root ? pathKey(item.root) === pathKey(root) : false);
    if (!target) {
      result = { removed: false, reason: 'not-found', snapshot: workspaceAccessSnapshot(config) };
      return config;
    }
    if (config.activeWorkspaceId === target.id) {
      throw new Error('The current project cannot be removed as an additional workspace');
    }
    config.trustedWritableRoots = trusted
      .filter(item => item.id !== target.id)
      .map(({ id: itemId, name: itemName, root: itemRoot }) => ({ id: itemId, name: itemName, root: itemRoot }));
    syncAdditionalWorkspaceEntries(config);
    result = { removed: true, workspace: publicWorkspace(target), snapshot: workspaceAccessSnapshot(config) };
    return config;
  }, { retries: 4 });
  return result;
}

module.exports = {
  PROTECTED_ROOT_SEGMENTS,
  addWorkspaceAccess,
  additionalWorkspaceId,
  listWorkspaceAccess,
  normalizeAdditionalWorkspace,
  normalizedAdditionalWorkspaces,
  pathKey,
  protectedRootReason,
  removeWorkspaceAccess,
  syncAdditionalWorkspaceEntries,
  workspaceAccessSnapshot
};
