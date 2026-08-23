'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withFileLockSync } = require('../config-file-lock.cjs');
const { CONNECTION_PROVIDERS, normalizeInstanceConfig } = require('./instance-config.cjs');
const { configureAuthentication } = require('./auth-config.cjs');
const { enforcePolicyGenerations, policyGenerationBaseline } = require('./config-policy-invariants.cjs');
const { DEFAULT_MAINTENANCE } = require('./maintenance-config.cjs');
const { DEFAULT_PORT, strictPort } = require('./port.cjs');
const CONFIG_SNAPSHOT = Symbol.for('devmate.configSnapshot');
const packageJson = require('../package.json');
const DEFAULT_VERSION = packageJson.version;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const SUPPORTED_CONFIG_VERSION = 12;

function normalizedWorkspaceRoot(root) {
  const resolved = path.resolve(String(root || '.'));
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); }
  catch { real = fs.realpathSync(resolved); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function workspaceForRoot(config, workspaceRoot) {
  const rootKey = normalizedWorkspaceRoot(path.resolve(workspaceRoot));
  return (config?.workspaces || []).find(item =>
    item && !item.reference && normalizedWorkspaceRoot(String(item.root || '.')) === rootKey
  ) || null;
}

function configError(message, code, file, cause = null) {
  const error = new Error(`${message}: ${file}`);
  error.code = code;
  error.configFile = file;
  if (cause) error.cause = cause;
  return error;
}

function parseJsonObjectFile(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return { exists: false, value: null, stat: null };
  if (!stat.isFile()) throw configError('DevMate config path is not a file', 'config_not_file', file);
  if (stat.size > MAX_CONFIG_BYTES) {
    const error = configError(`DevMate config exceeds ${MAX_CONFIG_BYTES} bytes (${stat.size} bytes)`, 'config_too_large', file);
    error.bytes = stat.size;
    error.maxBytes = MAX_CONFIG_BYTES;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw configError('DevMate config contains invalid JSON', 'config_invalid_json', file, cause);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw configError('DevMate config root must be a JSON object', 'config_invalid_root', file);
  }
  return { exists: true, value: parsed, stat };
}

function assertSupportedConfigVersion(config, file) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  if (!Object.hasOwn(config, 'version')) {
    const error = configError(
      `DevMate config has no schema version; version ${SUPPORTED_CONFIG_VERSION} is required`,
      'unsupported_config_version',
      file
    );
    error.configVersion = null;
    error.supportedVersion = SUPPORTED_CONFIG_VERSION;
    throw error;
  }
  const version = config.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    const error = configError(`DevMate config has an invalid version ${String(version)}`, 'invalid_config_version', file);
    error.configVersion = version;
    error.supportedVersion = SUPPORTED_CONFIG_VERSION;
    throw error;
  }
  if (version !== SUPPORTED_CONFIG_VERSION) {
    const error = configError(
      `DevMate config version ${version} is not supported; version ${SUPPORTED_CONFIG_VERSION} is required`,
      'unsupported_config_version',
      file
    );
    error.configVersion = version;
    error.supportedVersion = SUPPORTED_CONFIG_VERSION;
    throw error;
  }
  return config;
}

function readJson(file, fallback = null, { strict = false, supportedVersion = false } = {}) {
  try {
    const result = parseJsonObjectFile(file);
    if (!result.exists) return fallback;
    return supportedVersion ? assertSupportedConfigVersion(result.value, file) : result.value;
  } catch (error) {
    if (strict) throw error;
    return fallback;
  }
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function readConfigState(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return { exists: false, raw: '', hash: null, value: {} };
  if (!stat.isFile()) throw configError('DevMate config path is not a file', 'config_not_file', file);
  if (stat.size > MAX_CONFIG_BYTES) {
    const error = configError(`DevMate config exceeds ${MAX_CONFIG_BYTES} bytes (${stat.size} bytes)`, 'config_too_large', file);
    error.bytes = stat.size;
    error.maxBytes = MAX_CONFIG_BYTES;
    throw error;
  }
  let raw;
  let value;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    value = JSON.parse(raw);
  } catch (cause) {
    throw configError('DevMate config contains invalid JSON', 'config_invalid_json', file, cause);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('DevMate config root must be a JSON object', 'config_invalid_root', file);
  }
  assertSupportedConfigVersion(value, file);
  return { exists: true, raw, hash: fingerprint(raw), value };
}

function attachConfigSnapshot(value, file, state) {
  Object.defineProperty(value, CONFIG_SNAPSHOT, {
    value: Object.freeze({ file: path.resolve(file), exists: state.exists, hash: state.hash }),
    enumerable: false,
    configurable: false,
    writable: false
  });
  return value;
}

function readConfigSnapshot(file) {
  const target = path.resolve(file);
  recoverConfigReplacement(target);
  const state = readConfigState(target);
  return attachConfigSnapshot(state.value, target, state);
}

function configConflict(file) {
  return configError('DevMate config changed while it was being edited', 'config_conflict', file);
}

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function replacementCandidates(file) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.replace-`;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => {
      const candidate = path.join(directory, entry.name);
      const stat = fs.statSync(candidate, { throwIfNoEntry: false });
      return stat ? { file: candidate, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function replacementCompatibility(file) {
  try {
    const result = parseJsonObjectFile(file);
    if (!result.exists) return 'invalid';
    assertSupportedConfigVersion(result.value, file);
    return 'current';
  } catch (error) {
    return error?.code === 'unsupported_config_version' ? 'unsupported' : 'invalid';
  }
}

function validateReplacement(file) {
  return replacementCompatibility(file) === 'current';
}

function quarantineConfig(file, reason = 'corrupt') {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const quarantined = `${file}.${reason}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, quarantined);
    return quarantined;
  } catch {
    return null;
  }
}

function archiveUnsupportedLegacyConfig(file) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  return withFileLockSync(target, () => {
    let parsed = null;
    try { parsed = parseJsonObjectFile(target); }
    catch { return null; }
    if (!parsed.exists) return null;
    try {
      assertSupportedConfigVersion(parsed.value, target);
      return null;
    } catch (error) {
      const version = error?.configVersion;
      if (error?.code !== 'unsupported_config_version' || !Number.isInteger(version) || version < 1 || version >= SUPPORTED_CONFIG_VERSION) {
        throw error;
      }
      const archived = `${target}.legacy-v${version}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
      fs.renameSync(target, archived);
      try { fs.chmodSync(archived, 0o600); } catch {}
      fsyncDirectory(path.dirname(target));
      return archived;
    }
  });
}

function cleanupReplacementCandidates(candidates, except = '') {
  for (const candidate of candidates) {
    if (candidate.file === except || replacementCompatibility(candidate.file) === 'unsupported') continue;
    try { fs.rmSync(candidate.file, { force: true }); } catch {}
  }
}

function recoverConfigReplacement(file) {
  const candidates = replacementCandidates(file);
  let main = null;
  let mainError = null;
  try {
    main = parseJsonObjectFile(file);
    if (main.exists) assertSupportedConfigVersion(main.value, file);
  } catch (error) {
    mainError = error;
  }

  if (mainError?.code === 'unsupported_config_version') throw mainError;

  if (main?.exists && !mainError) {
    cleanupReplacementCandidates(candidates);
    return { recovered: false, source: null, quarantined: null, value: main.value };
  }

  const replacement = candidates.find(candidate => validateReplacement(candidate.file));
  if (replacement) {
    const quarantined = mainError ? quarantineConfig(file, 'corrupt') : null;
    if (fs.existsSync(file)) {
      const moved = quarantineConfig(file, 'replaced');
      if (!quarantined && moved) mainError ||= configError('Existing config was replaced during recovery', 'config_replaced', file);
    }
    fs.renameSync(replacement.file, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    fsyncDirectory(path.dirname(file));
    cleanupReplacementCandidates(candidates, replacement.file);
    const recovered = parseJsonObjectFile(file).value;
    assertSupportedConfigVersion(recovered, file);
    return { recovered: true, source: replacement.file, quarantined, value: recovered };
  }

  const unsupported = candidates.filter(candidate => replacementCompatibility(candidate.file) === 'unsupported');
  if (unsupported.length) {
    const error = configError(
      'DevMate config recovery found replacement data written by an incompatible schema version; preserved for a compatible DevMate version',
      'config_recovery_incompatible',
      file,
      mainError
    );
    error.replacementCandidates = unsupported.map(candidate => candidate.file);
    throw error;
  }

  if (!mainError && !main?.exists && candidates.length) {
    const error = configError('DevMate config is missing and interrupted replacement files are not valid', 'config_recovery_failed', file);
    error.replacementCandidates = candidates.map(candidate => candidate.file);
    throw error;
  }

  cleanupReplacementCandidates(candidates);
  if (mainError) {
    const quarantined = quarantineConfig(file, 'corrupt');
    mainError.quarantinedPath = quarantined;
    throw mainError;
  }
  return { recovered: false, source: null, quarantined: null, value: null };
}

function atomicWriteJson(file, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('DevMate config write requires a JSON object', 'config_invalid_write', file);
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_CONFIG_BYTES) {
    throw configError(`DevMate config exceeds ${MAX_CONFIG_BYTES} bytes`, 'config_too_large', file);
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${file}.replace-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      let moved = false;
      try {
        if (fs.existsSync(file)) {
          fs.renameSync(file, previous);
          moved = true;
        }
        fs.renameSync(temporary, file);
        if (moved) fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(file) && moved && fs.existsSync(previous)) {
          try { fs.renameSync(previous, file); } catch {}
        }
        throw replacementError;
      }
    }
    try { fs.chmodSync(file, 0o600); } catch {}
    fsyncDirectory(directory);
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function replaceConfig(file, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('DevMate config replacement requires a JSON object', 'config_invalid_write', file);
  }
  const target = path.resolve(file);
  const source = value[CONFIG_SNAPSHOT];
  if (!source || source.file !== target) {
    throw configError('DevMate config replacement requires a current snapshot', 'config_snapshot_required', target);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  return withFileLockSync(target, () => {
    recoverConfigReplacement(target);
    const current = readConfigState(target);
    if (current.exists !== source.exists || current.hash !== source.hash) throw configConflict(target);
    assertSupportedConfigVersion(value, target);
    if (current.exists) enforcePolicyGenerations(policyGenerationBaseline(current.value), value, target);
    atomicWriteJson(target, value);
    return readConfigSnapshot(target);
  });
}

function updateConfig(file, mutator, { retries = 3 } = {}) {
  if (typeof mutator !== 'function') throw new TypeError('Config mutator must be a function');
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const attempts = Math.min(10, Math.max(1, Math.trunc(Number(retries) || 3)));
  return withFileLockSync(target, () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      recoverConfigReplacement(target);
      const beforeState = readConfigState(target);
      const current = attachConfigSnapshot(beforeState.value, target, beforeState);
      const beforeJson = JSON.stringify(current);
      const policyBefore = beforeState.exists ? policyGenerationBaseline(current) : null;
      const changed = mutator(current);
      if (changed && typeof changed.then === 'function') throw new TypeError('Config mutator must be synchronous');
      if (changed === false) return current;
      const next = changed === undefined ? current : changed;
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        throw configError('Config mutator must return a JSON object', 'config_invalid_write', target);
      }
      assertSupportedConfigVersion(next, target);
      const afterState = readConfigState(target);
      if (afterState.exists !== beforeState.exists || afterState.hash !== beforeState.hash) {
        if (attempt === attempts - 1) throw configConflict(target);
        continue;
      }
      if (beforeState.exists) enforcePolicyGenerations(policyBefore, next, target);
      if (beforeState.exists && JSON.stringify(next) === beforeJson) return current;
      atomicWriteJson(target, next);
      return readConfigSnapshot(target);
    }
    throw configConflict(target);
  });
}

function workspaceId(root) {
  return path.basename(root)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'workspace';
}

function versionParts(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function newerVersion(current, candidate) {
  const left = versionParts(current);
  const right = versionParts(candidate);
  if (!left) return String(candidate || current || '');
  if (!right) return String(current || candidate || '');
  for (let index = 0; index < 3; index += 1) {
    if (right[index] > left[index]) return String(candidate);
    if (right[index] < left[index]) return String(current);
  }
  return String(current);
}

function newInstanceConfig({ workspaceRoot, port = DEFAULT_PORT, appVersion = DEFAULT_VERSION, defaultConnectionProvider = 'ngrok' }) {
  const root = path.resolve(workspaceRoot);
  const id = workspaceId(root);
  const serverPort = strictPort(port, { label: 'server.port' });
  const provider = String(defaultConnectionProvider || 'ngrok').trim().toLowerCase();
  if (!CONNECTION_PROVIDERS.includes(provider)) throw new Error(`Unknown default connection provider: ${provider}`);
  return {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion,
    instanceId: `host-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    server: { port: serverPort, mcpPath: '/mcp' },
    runtime: {
      defaultCommandTimeoutMs: 180000,
      maxOutputChars: 120000,
      maxPersistentProcesses: 16,
      persistentProcessOutputBytes: 2097152,
      maxConcurrentJobs: 2
    },
    maintenance: { ...DEFAULT_MAINTENANCE },
    connection: { provider, publicUrl: '', policyGeneration: 0 },
    auth: { mode: 'none' },
    permissions: {
      profile: 'fullAccess',
      readOnly: false,
      blockDangerousOperations: true,
      confirmBeforePush: false,
      allowDirectoryMutations: false
    },
    team: {
      members: [],
      requireWorkspaceLeaseForWrites: false,
      defaultMemberRole: 'developer',
      maxMembers: 100
    },
    requestPolicy: {
      maxRequestBytes: 2097152,
      requestsPerMinute: 600,
      maxConcurrentRequests: 64,
      maxConcurrentPerPrincipal: 16,
      requestTimeoutMs: 900000,
      allowedHosts: []
    },
    activeWorkspaceId: id,
    workspaces: [{
      id,
      name: path.basename(root),
      root,
      mode: 'workspace-write',
      reference: false,
      role: 'active'
    }],
    hostRuntime: {},
    hostContexts: {},
    activeHostId: null,
    commands: [],
    plugins: { enabled: [], settings: {} },
    jobs: { embeddedRunnerEnabled: false, allowJobGitSave: true },
    runnerControl: { enabled: false, credentials: [] },
    trustedWritableRoots: []
  };
}

function ensureInstanceConfig({ configFile, workspaceRoot, preferredPort = DEFAULT_PORT, appVersion = DEFAULT_VERSION, defaultConnectionProvider = 'ngrok' }) {
  const file = path.resolve(configFile);
  const root = path.resolve(workspaceRoot);
  const rootKey = normalizedWorkspaceRoot(root);
  const requestedPort = strictPort(preferredPort, { label: 'preferredPort' });
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  archiveUnsupportedLegacyConfig(file);
  return updateConfig(file, current => {
    if (!Object.keys(current).length) return newInstanceConfig({ workspaceRoot: root, port: requestedPort, appVersion, defaultConnectionProvider });
    const config = normalizeInstanceConfig(current);
    config.appVersion = newerVersion(config.appVersion, appVersion);
    config.instanceId ||= `host-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    config.hostRuntime ||= {};
    delete config.hostRuntime.workspaceRoot;
    config.server ||= {};
    config.server.port = strictPort(config.server.port ?? requestedPort, { label: 'server.port' });
    config.server.mcpPath ||= '/mcp';
    configureAuthentication(config);
    config.hostContexts ||= {};
    config.workspaces ||= [];
    let workspace = config.workspaces.find(item =>
      item && !item.reference && normalizedWorkspaceRoot(String(item.root || '.')) === rootKey
    );
    if (!workspace) {
      const base = workspaceId(root);
      let id = base;
      let counter = 2;
      const used = new Set(config.workspaces.map(item => item?.id).filter(Boolean));
      while (used.has(id)) id = `${base}-${counter++}`;
      workspace = {
        id,
        name: path.basename(root),
        root,
        mode: 'workspace-write',
        reference: false,
        role: 'active'
      };
      config.workspaces.push(workspace);
    }
    const activeWorkspace = config.workspaces.find(item => item && !item.reference && item.id === config.activeWorkspaceId);
    if (!activeWorkspace) config.activeWorkspaceId = workspace.id;
    for (const item of config.workspaces) {
      if (!item || item.reference) continue;
      item.role = item.id === config.activeWorkspaceId ? 'active' : (item.role === 'active' ? 'workspace' : item.role || 'workspace');
    }
    return config;
  });
}

function activateInstanceWorkspace({ configFile, workspaceRoot }) {
  const file = path.resolve(configFile);
  const root = path.resolve(workspaceRoot);
  const rootKey = normalizedWorkspaceRoot(root);
  return updateConfig(file, current => {
    const config = normalizeInstanceConfig(current);
    const workspace = (config.workspaces || []).find(item =>
      item && !item.reference && normalizedWorkspaceRoot(String(item.root || '.')) === rootKey
    );
    if (!workspace) {
      const error = configError('Workspace is not registered in the DevMate desktop instance', 'config_workspace_missing', file);
      error.requestedWorkspaceRoot = rootKey;
      throw error;
    }
    config.activeWorkspaceId = workspace.id;
    for (const item of config.workspaces) {
      if (!item || item.reference) continue;
      item.role = item.id === workspace.id ? 'active' : 'workspace';
    }
    return config;
  });
}

module.exports = {
  DEFAULT_VERSION,
  MAX_CONFIG_BYTES,
  SUPPORTED_CONFIG_VERSION,
  archiveUnsupportedLegacyConfig,
  assertSupportedConfigVersion,
  activateInstanceWorkspace,
  atomicWriteJson,
  cleanupReplacementCandidates,
  configError,
  configureAuthentication,
  ensureInstanceConfig,
  fsyncDirectory,
  newInstanceConfig,
  parseJsonObjectFile,
  quarantineConfig,
  readConfigSnapshot,
  readJson,
  replaceConfig,
  recoverConfigReplacement,
  replacementCandidates,
  replacementCompatibility,
  updateConfig,
  validateReplacement,
  newerVersion,
  versionParts,
  workspaceForRoot,
  workspaceId
};
