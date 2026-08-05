'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { MAX_CONFIG_BYTES, SUPPORTED_CONFIG_VERSION } = require('./host/runtime/constants.js');
const {
  assertSupportedConfigVersion,
  atomicWriteJson: writeConfigJson,
  recoverConfigReplacement,
  replacementCandidates: sharedReplacementCandidates,
  updateConfig
} = require('./host/runtime/config-store.js');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function has(objectValue, key) {
  return Object.hasOwn(objectValue, key);
}

function parseJsonValue(value) {
  const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value || ''), 'utf8');
  if (bytes > MAX_CONFIG_BYTES) {
    const error = new Error(`DevMate config exceeds the ${MAX_CONFIG_BYTES} byte limit (${bytes} bytes)`);
    error.code = 'config_too_large';
    throw error;
  }
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = new Error('DevMate config root must be a JSON object');
    error.code = 'config_invalid_root';
    throw error;
  }
  return parsed;
}

function mergeWorkspaces(candidate, current) {
  const requested = (Array.isArray(candidate) ? candidate : []).filter(item =>
    item?.trusted !== true && item?.role !== 'trusted'
  );
  const protectedCurrent = (Array.isArray(current) ? current : []).filter(item =>
    item?.trusted === true || item?.role === 'trusted'
  );
  const output = [...requested];
  const ids = new Set(output.map(item => item?.id).filter(Boolean));
  for (const workspace of protectedCurrent) {
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
    const initial = { ...candidate };
    initial.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(candidate.version) || 0);
    return initial;
  }

  const merged = { ...current };
  const extensionOwned = [
    'appVersion', 'server', 'permissions', 'maintenance', 'commands',
    'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'
  ];
  for (const key of extensionOwned) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }
  merged.version = Math.max(
    SUPPORTED_CONFIG_VERSION,
    Number(current.version) || 0,
    Number(candidate.version) || 0
  );
  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;

  const currentAuth = object(current.auth);
  const candidateAuth = object(candidate.auth);
  merged.auth = { ...currentAuth };
  if (!Object.keys(currentAuth).length) Object.assign(merged.auth, candidateAuth);
  if (has(candidateAuth, 'required')) merged.auth.required = candidateAuth.required;
  if (has(currentAuth, 'token')) merged.auth.token = currentAuth.token;
  else if (has(candidateAuth, 'token')) merged.auth.token = candidateAuth.token;

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
  if (has(currentTeam, 'members')) merged.team.members = currentTeam.members;
  else if (has(candidateTeam, 'members')) merged.team.members = candidateTeam.members;

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

function replacementCandidates(_fsModule, file) {
  return sharedReplacementCandidates(path.resolve(file));
}

function recoverReplacement(_fsModule, file) {
  const result = recoverConfigReplacement(path.resolve(file));
  return result.recovered ? result.source : null;
}

function atomicWriteJson(_fsModule, file, value) {
  assertSupportedConfigVersion(value, path.resolve(file));
  return writeConfigJson(path.resolve(file), value);
}

function writeMergedExtensionConfig(_fsModule, file, candidateValue) {
  const targetPath = path.resolve(file);
  const candidate = object(candidateValue);
  return updateConfig(targetPath, current => mergeExtensionConfig(current, candidate));
}

function createConfigFsProxy(fsModule, file) {
  const targetPath = path.resolve(file);
  const originalWriteFileSync = fsModule.writeFileSync.bind(fsModule);
  const interceptedWrite = function devmateScopedConfigWrite(candidatePath, data, options) {
    if (typeof candidatePath !== 'string' || path.resolve(candidatePath) !== targetPath) {
      return originalWriteFileSync(candidatePath, data, options);
    }
    const candidate = parseJsonValue(data);
    writeMergedExtensionConfig(fsModule, targetPath, candidate);
  };
  return new Proxy(fsModule, {
    get(target, property, receiver) {
      if (property === 'writeFileSync') return interceptedWrite;
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    }
  });
}

function loadWithConfigWriteInterceptor(modulePath, file) {
  const entry = require.resolve(modulePath);
  const moduleRoot = path.dirname(entry);
  const allowedNames = new Set(['extension-entry.js', 'extension-entry-win32.js', 'extension.js']);
  const configFs = createConfigFsProxy(fs, file);
  const originalLoad = Module._load;
  Module._load = function devmateScopedModuleLoad(request, parent, isMain) {
    const parentFile = parent?.filename ? path.resolve(parent.filename) : '';
    const parentAllowed = parentFile && path.dirname(parentFile) === moduleRoot && allowedNames.has(path.basename(parentFile));
    if ((request === 'fs' || request === 'node:fs') && parentAllowed) return configFs;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(entry);
  } finally {
    Module._load = originalLoad;
  }
}

module.exports = {
  MAX_CONFIG_BYTES,
  assertSupportedConfigVersion,
  atomicWriteJson,
  createConfigFsProxy,
  loadWithConfigWriteInterceptor,
  mergeExtensionConfig,
  parseJsonValue,
  recoverReplacement,
  replacementCandidates,
  writeMergedExtensionConfig
};