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

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

function mergeWorkspaces(candidate, current) {
  const requested = (Array.isArray(candidate) ? candidate : []).filter(item =>
    item?.trusted !== true && item?.role !== 'trusted'
  );
  const trusted = (Array.isArray(current) ? current : []).filter(item =>
    item?.trusted === true || item?.role === 'trusted'
  );
  const output = [...requested];
  const ids = new Set(output.map(item => item?.id).filter(Boolean));
  for (const workspace of trusted) {
    if (!ids.has(workspace.id)) output.push(workspace);
  }
  return output;
}

function workspacePathKey(value) {
  const resolved = path.resolve(String(value || '.'));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameWorkspacePath(left, right) {
  return !!left && !!right && workspacePathKey(left) === workspacePathKey(right);
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
  candidate.activeWorkspaceId = id;
  candidate.workspaces = [
    {
      ...currentWorkspace,
      id,
      name: path.basename(workspaceRoot),
      root: workspaceRoot,
      mode: 'workspace-write',
      reference: false,
      role: 'active'
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

function mergeHostContexts(currentValue, candidateValue, { refreshHostId = '' } = {}) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  const merged = { ...current };
  for (const [hostId, context] of Object.entries(candidate)) {
    merged[hostId] = hostId !== refreshHostId && has(current, hostId) && sameHostContext(current[hostId], context)
      ? current[hostId]
      : context;
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
  for (const key of [
    'appVersion', 'permissions', 'maintenance', 'commands',
    'activeWorkspaceId'
  ]) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }

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

  if (has(candidate, 'workspaces')) {
    merged.workspaces = mergeWorkspaces(candidate.workspaces, current.workspaces);
  } else if (has(current, 'workspaces')) {
    merged.workspaces = current.workspaces;
  }

  for (const key of [
    'connection', 'team', 'requestPolicy', 'hostRuntime', 'plugins',
    'jobs', 'runnerControl', 'trustedWritableRoots'
  ]) {
    preserveCurrentObject(merged, current, key);
  }

  if (has(candidate, 'hostContexts') || has(current, 'hostContexts')) {
    const refreshHostId = has(candidate, 'activeHostId') && candidate.activeHostId !== current.activeHostId
      ? String(candidate.activeHostId || '')
      : '';
    merged.hostContexts = mergeHostContexts(current.hostContexts, candidate.hostContexts, { refreshHostId });
  }
  if (has(candidate, 'activeHostId')) merged.activeHostId = candidate.activeHostId;
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
  mergeExtensionConfig,
  mergeHostContexts,
  mergeWorkspaces,
  readExtensionConfig,
  syncCurrentWorkspace,
  writeExtensionConfig
};
