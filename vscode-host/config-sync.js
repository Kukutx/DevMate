
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
  assertSupportedConfigVersion(current);
  assertSupportedConfigVersion(candidate);

  if (!Object.keys(current).length) {
    return {
      ...candidate,
      version: Math.max(Number(candidate.version) || 0, SUPPORTED_CONFIG_VERSION)
    };
  }

  const merged = { ...current };
  for (const key of [
    'appVersion', 'server', 'permissions', 'maintenance', 'commands',
    'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'
  ]) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }

  merged.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(current.version) || 0, Number(candidate.version) || 0);
  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;

  const currentAuth = object(current.auth);
  const candidateAuth = object(candidate.auth);
  merged.auth = { ...currentAuth };
  if (!Object.keys(currentAuth).length) Object.assign(merged.auth, candidateAuth);
  if (has(candidateAuth, 'required')) merged.auth.required = candidateAuth.required;
  if (!has(currentAuth, 'token') && has(candidateAuth, 'token')) merged.auth.token = candidateAuth.token;

  const currentRuntime = object(current.runtime);
  const candidateRuntime = object(candidate.runtime);
  merged.runtime = Object.keys(currentRuntime).length ? { ...currentRuntime } : { ...candidateRuntime };
  for (const key of ['defaultCommandTimeoutMs', 'maxOutputChars']) {
    if (has(candidateRuntime, key)) merged.runtime[key] = candidateRuntime[key];
  }

  const currentTeam = object(current.team);
  const candidateTeam = object(candidate.team);
  merged.team = Object.keys(currentTeam).length ? { ...currentTeam } : { ...candidateTeam };
  for (const key of ['enabled', 'requireWorkspaceLeaseForWrites']) {
    if (has(candidateTeam, key)) merged.team[key] = candidateTeam[key];
  }
  if (!has(currentTeam, 'members') && has(candidateTeam, 'members')) merged.team.members = candidateTeam.members;

  if (has(candidate, 'workspaces') || has(current, 'workspaces')) {
    merged.workspaces = mergeWorkspaces(candidate.workspaces, current.workspaces);
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
