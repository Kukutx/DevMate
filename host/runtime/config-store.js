'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withFileLockSync } = require('../../config-file-lock.cjs');
const { DEFAULT_PORT, DEFAULT_VERSION, MAX_CONFIG_BYTES } = require('./constants.js');
const { normalizedWorkspaceRoot } = require('./state-paths.js');

function readJson(file, fallback = null) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) return fallback;
    if (stat.size > MAX_CONFIG_BYTES) throw new Error(`Config exceeds ${MAX_CONFIG_BYTES} bytes`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
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

function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error(`Config exceeds ${MAX_CONFIG_BYTES} bytes`);
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
      const previous = `${file}.replace-${process.pid}-${Date.now()}`;
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
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLockSync(file, () => {
    const current = readJson(file, {}) || {};
    const next = mutator(current) || current;
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
    version: 11,
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
    config.version = Math.max(11, Number(config.version) || 0);
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
  atomicWriteJson,
  ensurePersonalConfig,
  fsyncDirectory,
  newPersonalConfig,
  randomToken,
  readJson,
  updateConfig,
  workspaceId
};
