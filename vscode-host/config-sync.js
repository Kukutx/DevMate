'use strict';

const {
  SUPPORTED_CONFIG_VERSION,
  assertSupportedConfigVersion,
  readJson,
  updateConfig
} = require('../shared/config-store.cjs');

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

function mergeExtensionConfig(currentValue, candidateValue) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  const initializing = Object.keys(current).length === 0;
  if (!initializing) assertSupportedConfigVersion(current);
  assertSupportedConfigVersion(candidate);

  const merged = { ...current };
  for (const key of [
    'appVersion', 'server', 'permissions', 'maintenance', 'commands',
    'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'
  ]) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }

  merged.version = SUPPORTED_CONFIG_VERSION;
  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;

  const currentAuth = object(current.auth);
  const candidateAuth = object(candidate.auth);
  merged.auth = { ...currentAuth };
  if (has(candidateAuth, 'required')) merged.auth.required = candidateAuth.required;
  if (!has(currentAuth, 'token') && has(candidateAuth, 'token')) merged.auth.token = candidateAuth.token;

  const currentRuntime = object(current.runtime);
  const candidateRuntime = object(candidate.runtime);
  merged.runtime = { ...currentRuntime };
  for (const key of ['defaultCommandTimeoutMs', 'maxOutputChars']) {
    if (has(candidateRuntime, key)) merged.runtime[key] = candidateRuntime[key];
  }

  const currentTeam = object(current.team);
  const candidateTeam = object(candidate.team);
  merged.team = { ...currentTeam };
  for (const key of ['enabled', 'requireWorkspaceLeaseForWrites']) {
    if (has(candidateTeam, key)) merged.team[key] = candidateTeam[key];
  }

  if (has(candidate, 'workspaces')) {
    merged.workspaces = mergeWorkspaces(candidate.workspaces, current.workspaces);
  } else if (has(current, 'workspaces')) {
    merged.workspaces = current.workspaces;
  }

  for (const key of ['hostRuntime', 'plugins', 'jobs', 'runnerControl', 'task', 'trustedWritableRoots']) {
    if (has(current, key)) merged[key] = current[key];
    else delete merged[key];
  }

  if (has(candidate, 'hostContexts') || has(current, 'hostContexts')) {
    merged.hostContexts = { ...object(current.hostContexts), ...object(candidate.hostContexts) };
  }
  if (has(candidate, 'activeHostId')) merged.activeHostId = candidate.activeHostId;
  return merged;
}

function readExtensionConfig(file) {
  return readJson(file, null, { strict: true, supportedVersion: true });
}

function writeExtensionConfig(file, candidate) {
  return updateConfig(file, current => mergeExtensionConfig(current, candidate));
}

module.exports = {
  mergeExtensionConfig,
  mergeWorkspaces,
  readExtensionConfig,
  writeExtensionConfig
};