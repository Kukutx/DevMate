'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withFileLockSync } = require('../../config-file-lock.cjs');
const {
  DEFAULT_PORT,
  DEFAULT_VERSION,
  MAX_CONFIG_BYTES,
  SUPPORTED_CONFIG_VERSION
} = require('./constants.js');
const { normalizedWorkspaceRoot } = require('./state-paths.js');

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
  const version = Number(config?.version || 0);
  if (Number.isFinite(version) && version > SUPPORTED_CONFIG_VERSION) {
    const error = configError(
      `DevMate config version ${version} is newer than supported version ${SUPPORTED_CONFIG_VERSION}`,
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

function validateReplacement(file) {
  try {
    const result = parseJsonObjectFile(file);
    if (!result.exists) return false;
    assertSupportedConfigVersion(result.value, file);
    return true;
  } catch {
    return false;
  }
}

function quarantineConfig(file, reason = 'corrupt') {
  if (!fs.existsSync(file)) return null;
  const quarantined = `${file}.${reason}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(file, quarantined);
    return quarantined;
  } catch {
    return null;
  }
}

function cleanupReplacementCandidates(candidates, except = '') {
  for (const candidate of candidates) {
    if (candidate.file === except) continue;
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

function updateConfig(file, mutator) {
  if (typeof mutator !== 'function') throw new TypeError('Config mutator must be a function');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(file, () => {
    const recovery = recoverConfigReplacement(file);
    const current = recovery.value || {};
    assertSupportedConfigVersion(current, file);
    const next = mutator(current) || current;
    assertSupportedConfigVersion(next, file);
    atomicWriteJson(file, next);
    return next;
  });
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function workspaceId(root) {
  return path.basename(root)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'workspace';
}

function newPersonalConfig({ workspaceRoot, port = DEFAULT_PORT, appVersion = DEFAULT_VERSION }) {
  const root = path.resolve(workspaceRoot);
  const id = workspaceId(root);
  return {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion,
    instanceId: `host-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    server: { port, mcpPath: '/mcp' },
    runtime: {
      defaultCommandTimeoutMs: 180000,
      maxOutputChars: 120000,
      maxPersistentProcesses: 16,
      persistentProcessOutputBytes: 2097152
    },
    maintenance: {
      backupRetentionDays: 30,
      auditRetentionDays: 30,
      maxBackupBytes: 1073741824,
      maxAuditBytes: 20971520
    },
    connection: {},
    auth: { required: true, token: randomToken() },
    permissions: {
      profile: 'fullAccess',
      readOnly: false,
      blockDangerousOperations: true,
      confirmBeforePush: false,
      allowDirectoryMutations: false
    },
    deployment: { mode: 'personal', tunnelProvider: 'external', publicUrl: '' },
    team: {
      enabled: false,
      members: [],
      requireWorkspaceLeaseForWrites: false,
      defaultMemberRole: 'developer',
      maxMembers: 100
    },
    production: {
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
    hostContexts: {},
    activeHostId: null,
    vscodeContext: {
      capturedAt: null,
      activeEditor: null,
      visibleEditors: [],
      diagnostics: []
    },
    commands: [],
    plugins: { enabled: [], settings: {} },
    jobs: { embeddedRunnerEnabled: true, allowJobGitSave: true },
    runnerControl: { enabled: false, credentials: [] },
    trustedWritableRoots: []
  };
}

function ensurePersonalConfig({ configFile, workspaceRoot, preferredPort = DEFAULT_PORT, appVersion = DEFAULT_VERSION }) {
  const file = path.resolve(configFile);
  const root = path.resolve(workspaceRoot);
  const rootKey = normalizedWorkspaceRoot(root);
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${root}`);
  }
  return updateConfig(file, current => {
    if (!Object.keys(current).length) return newPersonalConfig({ workspaceRoot: root, port: preferredPort, appVersion });
    const config = current;
    config.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(config.version) || 0);
    config.appVersion = appVersion;
    config.instanceId ||= `host-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    config.server ||= {};
    config.server.port = Number(config.server.port || preferredPort || DEFAULT_PORT);
    config.server.mcpPath ||= '/mcp';
    config.auth ||= {};
    config.auth.required = config.auth.required !== false;
    config.auth.token ||= randomToken();
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
    config.activeWorkspaceId = workspace.id;
    for (const item of config.workspaces) {
      if (!item || item.reference) continue;
      item.role = item.id === workspace.id ? 'active' : (item.role === 'active' ? 'workspace' : item.role || 'workspace');
    }
    return config;
  });
}

module.exports = {
  assertSupportedConfigVersion,
  atomicWriteJson,
  cleanupReplacementCandidates,
  configError,
  ensurePersonalConfig,
  fsyncDirectory,
  newPersonalConfig,
  parseJsonObjectFile,
  quarantineConfig,
  randomToken,
  readJson,
  recoverConfigReplacement,
  replacementCandidates,
  updateConfig,
  validateReplacement,
  workspaceId
};
