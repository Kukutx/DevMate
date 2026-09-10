'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  SUPPORTED_CONFIG_VERSION,
  assertSupportedConfigVersion,
  readJson,
  recoverConfigReplacement,
  updateConfig
} = require('../shared/config-store.cjs');
const { withFileLockSync } = require('../config-file-lock.cjs');
const { assertSupportedInstanceShape } = require('../shared/instance-config.cjs');
const { normalizeAuthentication } = require('../shared/auth-config.cjs');
const {
  prunedHostContexts,
  publisherHostId,
  timestampMs
} = require('../shared/host-registry.cjs');

const HOST_REGISTRY_RUNTIME_FIELDS = Object.freeze([
  'focusedHostId',
  'lastInteractiveHostId',
  'lastInteractiveAt'
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

function workspacePathKey(value) {
  const resolved = path.resolve(String(value || '.'));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameWorkspacePath(left, right) {
  return !!left && !!right && workspacePathKey(left) === workspacePathKey(right);
}

function mergeWorkspaces(candidate, current) {
  const requested = (Array.isArray(candidate) ? candidate : []).filter(item =>
    item && item.trusted !== true && item.role !== 'trusted'
  );
  const retainedWritable = (Array.isArray(current) ? current : []).filter(item =>
    item && (item.trusted === true || item.role === 'trusted' || (!item.reference && item.mode !== 'readonly'))
  );
  const output = [...requested];
  const ids = new Set(output.map(item => item?.id).filter(Boolean));
  const roots = new Set(output.map(item => item?.root).filter(Boolean).map(workspacePathKey));
  for (const workspace of retainedWritable) {
    const rootKey = workspace?.root ? workspacePathKey(workspace.root) : '';
    if (ids.has(workspace.id) || (rootKey && roots.has(rootKey))) continue;
    output.push(workspace);
    if (workspace.id) ids.add(workspace.id);
    if (rootKey) roots.add(rootKey);
  }
  return output;
}

function workspaceIdForRoot(root) {
  return path.basename(root).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'workspace';
}

function uniqueWorkspaceId(workspaces, base) {
  const cleanBase = String(base || 'workspace').replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || 'workspace';
  const ids = new Set((workspaces || []).map(item => item?.id).filter(Boolean));
  let id = cleanBase;
  let suffix = 2;
  while (ids.has(id)) id = `${cleanBase}-${suffix++}`;
  return id;
}

function syncCurrentWorkspace(candidate, root) {
  const workspaceRoot = path.resolve(String(root || '.'));
  const workspaces = Array.isArray(candidate.workspaces) ? candidate.workspaces : [];
  const existing = workspaces.find(item => item && sameWorkspacePath(item.root, workspaceRoot)) || null;
  const retained = workspaces.filter(item => !sameWorkspacePath(item?.root, workspaceRoot));
  let id = String(existing?.id || workspaceIdForRoot(workspaceRoot));
  if (retained.some(item => item?.id === id)) id = uniqueWorkspaceId(retained, workspaceIdForRoot(workspaceRoot));
  const { trusted: _trusted, ...currentWorkspace } = existing || {};
  candidate.workspaces = [
    {
      ...currentWorkspace,
      id,
      name: path.basename(workspaceRoot),
      root: workspaceRoot,
      mode: 'workspace-write',
      reference: false,
      role: id === candidate.activeWorkspaceId ? 'active' : 'workspace'
    },
    ...retained
  ];
  return candidate;
}

function preserveCurrentObject(merged, current, key) {
  if (has(current, key)) merged[key] = current[key];
  else delete merged[key];
}

function comparableHostContext(value) {
  const context = { ...object(value) };
  delete context.capturedAt;
  delete context.updatedAt;
  return context;
}

function sameHostContext(left, right) {
  return JSON.stringify(comparableHostContext(left)) === JSON.stringify(comparableHostContext(right));
}

function samePersistedHostContext(left, right) {
  return JSON.stringify(object(left)) === JSON.stringify(object(right));
}

function mergeOneHostContext(currentContext, candidateContext) {
  if (!currentContext) return candidateContext;
  if (!candidateContext) return currentContext;
  if (timestampMs(currentContext) > timestampMs(candidateContext)) return currentContext;
  return sameHostContext(currentContext, candidateContext) ? currentContext : candidateContext;
}

function mergeHostContexts(currentValue, candidateValue, {
  refreshHostId = '',
  prunedContexts = {}
} = {}) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  const merged = { ...current };

  for (const [hostId, staleSnapshot] of Object.entries(object(prunedContexts))) {
    if (has(current, hostId) && samePersistedHostContext(current[hostId], staleSnapshot)) delete merged[hostId];
  }

  if (refreshHostId) {
    if (has(candidate, refreshHostId)) {
      merged[refreshHostId] = mergeOneHostContext(current[refreshHostId], candidate[refreshHostId]);
    }
    return merged;
  }
  for (const [hostId, context] of Object.entries(candidate)) {
    merged[hostId] = mergeOneHostContext(current[hostId], context);
  }
  return merged;
}

function mergeHostRuntime(currentValue, candidateValue, {
  refreshHostId = '',
  currentContexts = {},
  candidateContexts = {}
} = {}) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  const merged = { ...current };

  if (!refreshHostId) {
    for (const key of HOST_REGISTRY_RUNTIME_FIELDS) {
      if (has(candidate, key)) merged[key] = candidate[key];
      else delete merged[key];
    }
    return merged;
  }

  const currentWriterContext = object(currentContexts)[refreshHostId];
  const writerContext = object(candidateContexts)[refreshHostId];
  const currentFocusedId = String(current.focusedHostId || '');
  const currentFocusedContext = object(currentContexts)[currentFocusedId];
  const writerStamp = timestampMs(writerContext);
  const focusedStamp = timestampMs(currentFocusedContext);
  const writerFocused = writerContext?.focused === true;
  const semanticNoop = currentFocusedId === refreshHostId && sameHostContext(currentWriterContext, writerContext);
  const writerCanTakeFocus = writerFocused && (
    !currentFocusedId || currentFocusedId === refreshHostId || writerStamp >= focusedStamp
  );

  if (writerCanTakeFocus) {
    merged.focusedHostId = refreshHostId;
    if (!semanticNoop) {
      const candidateInteractiveAt = String(candidate.lastInteractiveAt || writerContext.updatedAt || writerContext.capturedAt || '');
      const currentInteractiveAt = String(current.lastInteractiveAt || '');
      if (!currentInteractiveAt || !candidateInteractiveAt || candidateInteractiveAt >= currentInteractiveAt) {
        merged.lastInteractiveHostId = refreshHostId;
        if (candidateInteractiveAt) merged.lastInteractiveAt = candidateInteractiveAt;
      }
    }
  } else if (!writerFocused && currentFocusedId === refreshHostId) {
    delete merged.focusedHostId;
  }
  return merged;
}

function mergeExtensionConfig(currentValue, candidateValue) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  const initializing = Object.keys(current).length === 0;
  if (!initializing) assertSupportedConfigVersion(current);
  assertSupportedConfigVersion(candidate);
  assertSupportedInstanceShape(current);
  assertSupportedInstanceShape(candidate);

  const merged = { ...current };
  for (const key of ['appVersion', 'maintenance', 'commands']) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }
  if (initializing && has(candidate, 'activeWorkspaceId')) merged.activeWorkspaceId = candidate.activeWorkspaceId;

  merged.version = SUPPORTED_CONFIG_VERSION;
  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;

  if (has(current, 'server')) merged.server = current.server;
  else if (has(candidate, 'server')) merged.server = candidate.server;

  if (has(candidate, 'auth')) merged.auth = normalizeAuthentication({ auth: candidate.auth });
  else if (has(current, 'auth')) merged.auth = normalizeAuthentication({ auth: current.auth });
  else delete merged.auth;

  const currentRuntime = object(current.runtime);
  const candidateRuntime = object(candidate.runtime);
  merged.runtime = { ...currentRuntime };
  for (const key of ['defaultCommandTimeoutMs', 'maxOutputChars']) {
    if (has(candidateRuntime, key)) merged.runtime[key] = candidateRuntime[key];
  }

  if (has(candidate, 'workspaces')) merged.workspaces = mergeWorkspaces(candidate.workspaces, current.workspaces);
  else if (has(current, 'workspaces')) merged.workspaces = current.workspaces;

  for (const key of [
    'activeWorkspaceId', 'permissions', 'connection', 'team', 'requestPolicy', 'plugins',
    'jobs', 'runnerControl', 'trustedWritableRoots'
  ]) {
    if (!initializing || key !== 'activeWorkspaceId') preserveCurrentObject(merged, current, key);
  }

  const refreshHostId = publisherHostId(candidate);
  const staleContexts = prunedHostContexts(candidate);
  const hostRuntime = mergeHostRuntime(current.hostRuntime, candidate.hostRuntime, {
    refreshHostId,
    currentContexts: current.hostContexts,
    candidateContexts: candidate.hostContexts
  });
  if (Object.keys(hostRuntime).length || has(current, 'hostRuntime')) merged.hostRuntime = hostRuntime;
  else delete merged.hostRuntime;

  if (has(candidate, 'hostContexts') || has(current, 'hostContexts')) {
    merged.hostContexts = mergeHostContexts(current.hostContexts, candidate.hostContexts, {
      refreshHostId,
      prunedContexts: staleContexts
    });
  }

  if (merged.hostRuntime?.focusedHostId && !merged.hostContexts?.[merged.hostRuntime.focusedHostId]) {
    delete merged.hostRuntime.focusedHostId;
  }

  if (refreshHostId) {
    const focusedHostId = String(merged.hostRuntime?.focusedHostId || '');
    if (focusedHostId && merged.hostContexts?.[focusedHostId]) merged.activeHostId = focusedHostId;
    else if (!merged.hostContexts?.[merged.activeHostId]) {
      if (candidate.activeHostId && merged.hostContexts?.[candidate.activeHostId]) merged.activeHostId = candidate.activeHostId;
      else if (merged.hostContexts?.[refreshHostId]) merged.activeHostId = refreshHostId;
    }
  } else if (has(candidate, 'activeHostId')) {
    merged.activeHostId = candidate.activeHostId;
  }
  delete merged.vscodeContext;
  return merged;
}

function parseExtensionConfig(file) {
  const config = readJson(file, null, { strict: true, supportedVersion: true });
  if (config) assertSupportedInstanceShape(config);
  return config;
}

function readExtensionConfig(file) {
  const directory = path.dirname(path.resolve(file));
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return null;
  const current = parseExtensionConfig(file);
  if (current) return current;
  return withFileLockSync(file, () => {
    recoverConfigReplacement(file);
    return parseExtensionConfig(file);
  });
}

function writeExtensionConfig(file, candidate) {
  return updateConfig(file, current => {
    if (!Object.keys(current).length) {
      const error = new Error('DevMate shared config is missing; restart the host runtime to initialize it safely');
      error.code = 'DEVMATE_SHARED_CONFIG_MISSING';
      error.configFile = file;
      throw error;
    }
    return mergeExtensionConfig(current, candidate);
  });
}

module.exports = {
  HOST_REGISTRY_RUNTIME_FIELDS,
  mergeExtensionConfig,
  mergeHostContexts,
  mergeHostRuntime,
  mergeWorkspaces,
  readExtensionConfig,
  syncCurrentWorkspace,
  writeExtensionConfig
};
