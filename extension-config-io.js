'use strict';

const fs = require('fs');
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const { withFileLockSync } = require('./config-file-lock.cjs');
const { SUPPORTED_CONFIG_VERSION } = require('./host/runtime/constants.js');

const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

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
    throw new Error('DevMate config root must be a JSON object');
  }
  return parsed;
}

function assertSupportedConfigVersion(value, file = 'DevMate config') {
  const version = Number(value?.version || 0);
  if (Number.isFinite(version) && version > SUPPORTED_CONFIG_VERSION) {
    const error = new Error(`DevMate config version ${version} is newer than supported version ${SUPPORTED_CONFIG_VERSION}: ${file}`);
    error.code = 'unsupported_config_version';
    error.configVersion = version;
    error.supportedVersion = SUPPORTED_CONFIG_VERSION;
    error.configFile = file;
    throw error;
  }
  return value;
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
    return { ...candidate, version: Math.max(SUPPORTED_CONFIG_VERSION, Number(candidate.version) || 0) };
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

  for (const key of ['plugins', 'jobs', 'runnerControl', 'task', 'trustedWritableRoots']) {
    if (has(current, key)) merged[key] = current[key];
    else delete merged[key];
  }
  return merged;
}

function fsyncDirectory(fsModule, directory) {
  let fd = null;
  try {
    fd = fsModule.openSync(directory, 'r');
    fsModule.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try { fsModule.closeSync(fd); } catch {}
    }
  }
}

function replacementCandidates(fsModule, file) {
  const directory = path.dirname(file);
  if (!fsModule.existsSync(directory)) return [];
  const prefix = `${path.basename(file)}.replace-`;
  return fsModule.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => {
      const target = path.join(directory, entry.name);
      const stat = fsModule.statSync(target, { throwIfNoEntry: false });
      return stat ? { file: target, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function validConfigFile(fsModule, file) {
  try {
    const stat = fsModule.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_CONFIG_BYTES) return false;
    const parsed = parseJsonValue(fsModule.readFileSync(file, 'utf8'));
    assertSupportedConfigVersion(parsed, file);
    return true;
  } catch { return false; }
}

function recoverReplacement(fsModule, file) {
  const candidates = replacementCandidates(fsModule, file);
  let mainError = null;
  if (fsModule.existsSync(file)) {
    try {
      const current = parseJsonValue(fsModule.readFileSync(file, 'utf8'));
      assertSupportedConfigVersion(current, file);
      for (const candidate of candidates) {
        try { fsModule.rmSync(candidate.file, { force: true }); } catch {}
      }
      return null;
    } catch (error) {
      if (error?.code === 'unsupported_config_version') throw error;
      mainError = error;
    }
  }
  const candidate = candidates.find(item => validConfigFile(fsModule, item.file));
  if (!candidate) {
    if (mainError) {
      const quarantined = `extension-config-io.js.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      try { fsModule.renameSync(file, quarantined); mainError.quarantinedPath = quarantined; } catch {}
      throw mainError;
    }
    return null;
  }
  if (fsModule.existsSync(file)) {
    try { fsModule.renameSync(file, `${file}.corrupt-${Date.now()}`); }
    catch { try { fsModule.rmSync(file, { force: true }); } catch {} }
  }
  fsModule.renameSync(candidate.file, file);
  try { fsModule.chmodSync(file, 0o600); } catch {}
  fsyncDirectory(fsModule, path.dirname(file));
  for (const stale of candidates.slice(1)) {
    try { fsModule.rmSync(stale.file, { force: true }); } catch {}
  }
  return candidate.file;
}

function readCurrent(fsModule, file) {
  recoverReplacement(fsModule, file);
  if (!fsModule.existsSync(file)) return {};
  return parseJsonValue(fsModule.readFileSync(file, 'utf8'));
}

function atomicWriteJson(fsModule, file, value, originalWriteFileSync = fsModule.writeFileSync.bind(fsModule)) {
  const directory = path.dirname(file);
  fsModule.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fsModule.chmodSync(directory, 0o700); } catch {}
  recoverReplacement(fsModule, file);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_CONFIG_BYTES) {
    const error = new Error(`DevMate config exceeds the ${MAX_CONFIG_BYTES} byte limit (${payloadBytes} bytes)`);
    error.code = 'config_too_large';
    throw error;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fsModule.openSync(temporary, 'wx', 0o600);
    originalWriteFileSync(fd, payload, 'utf8');
    try { fsModule.fsyncSync(fd); } catch {}
    fsModule.closeSync(fd);
    fd = null;
    try {
      fsModule.renameSync(temporary, file);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${file}.replace-${process.pid}-${Date.now()}`;
      let moved = false;
      try {
        if (fsModule.existsSync(file)) {
          fsModule.renameSync(file, previous);
          moved = true;
        }
        fsModule.renameSync(temporary, file);
        fsyncDirectory(fsModule, directory);
        if (moved) fsModule.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fsModule.existsSync(file) && moved && fsModule.existsSync(previous)) {
          try { fsModule.renameSync(previous, file); } catch {}
        }
        throw replacementError;
      }
    }
    try { fsModule.chmodSync(file, 0o600); } catch {}
    fsyncDirectory(fsModule, directory);
  } finally {
    if (fd != null) {
      try { fsModule.closeSync(fd); } catch {}
    }
    try { fsModule.rmSync(temporary, { force: true }); } catch {}
  }
}

function writeMergedExtensionConfig(fsModule, file, candidateValue) {
  return withFileLockSync(file, () => {
    const candidate = object(candidateValue);
    const current = readCurrent(fsModule, file);
    const merged = mergeExtensionConfig(current, candidate);
    atomicWriteJson(fsModule, file, merged);
    return merged;
  });
}

function createConfigFsProxy(fsModule, file) {
  const targetPath = path.resolve(file);
  const originalWriteFileSync = fsModule.writeFileSync.bind(fsModule);
  const interceptedWrite = function devmateScopedConfigWrite(candidatePath, data, options) {
    if (typeof candidatePath !== 'string' || path.resolve(candidatePath) !== targetPath) {
      return originalWriteFileSync(candidatePath, data, options);
    }
    const candidate = parseJsonValue(data);
    withFileLockSync(targetPath, () => {
      const current = readCurrent(fsModule, targetPath);
      atomicWriteJson(fsModule, targetPath, mergeExtensionConfig(current, candidate), originalWriteFileSync);
    });
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
    if (request === 'fs' && parentAllowed) return configFs;
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
