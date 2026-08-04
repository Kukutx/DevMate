'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { withFileLockSync } = require('../config-file-lock.cjs');

const DEFAULT_PORT = 8787;
const DEFAULT_VERSION = '2.9.2';
const DEFAULT_START_TIMEOUT_MS = 15000;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;

function now() {
  return new Date().toISOString();
}

function expandHome(value, homeDirectory = os.homedir()) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return homeDirectory;
  if (text.startsWith(`~${path.sep}`) || text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(homeDirectory, text.slice(2));
  }
  return text;
}

function normalizedWorkspaceRoot(root) {
  const resolved = path.resolve(String(root || '.'));
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); }
  catch { try { real = fs.realpathSync(resolved); } catch {} }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function workspaceRuntimeId(root) {
  const normalized = normalizedWorkspaceRoot(root);
  const base = path.basename(normalized)
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'workspace';
  const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
  return `${base}-${digest}`;
}

function defaultSharedStateDirectory(root, { homeDirectory = os.homedir() } = {}) {
  if (!root) throw new Error('A workspace root is required to resolve shared DevMate state');
  return path.join(homeDirectory, '.devmate', 'hosts', workspaceRuntimeId(root));
}

function resolveStateDirectory({
  workspaceRoot,
  overrideDirectory = '',
  legacyDirectory = '',
  shared = true,
  homeDirectory = os.homedir()
} = {}) {
  const override = expandHome(overrideDirectory, homeDirectory);
  if (override) return path.resolve(override);
  if (shared && workspaceRoot) return defaultSharedStateDirectory(workspaceRoot, { homeDirectory });
  if (legacyDirectory) return path.resolve(legacyDirectory);
  if (!workspaceRoot) throw new Error('A workspace root or state directory is required');
  return path.join(path.resolve(workspaceRoot), '.devmate-server');
}

function copyDirectory(source, target) {
  const ignored = new Set(['gateway.lock', 'runtime.pid', 'runtime.json']);
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
    filter(candidate) {
      const base = path.basename(candidate);
      return !ignored.has(base) && !base.endsWith('.lock') && !base.endsWith('.tmp') && !base.includes('.replace-');
    }
  });
}

function migrateLegacyState({ legacyDirectory, stateDirectory } = {}) {
  if (!legacyDirectory || !stateDirectory) return { migrated: false, reason: 'missing-directory' };
  const source = path.resolve(legacyDirectory);
  const target = path.resolve(stateDirectory);
  if (source === target) return { migrated: false, reason: 'same-directory' };
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    return { migrated: false, reason: 'legacy-missing' };
  }
  const targetConfig = path.join(target, 'config.json');
  if (fs.existsSync(targetConfig)) return { migrated: false, reason: 'target-config-exists' };
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  copyDirectory(source, target);
  return { migrated: fs.existsSync(targetConfig), reason: 'copied' };
}

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

function httpJson(url, timeoutMs = 1500) {
  return new Promise(resolve => {
    let request;
    try {
      request = http.get(url, { timeout: timeoutMs }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            status: response.statusCode,
            json,
            text
          });
        });
      });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', error => resolve({ ok: false, error: error.message }));
  });
}

function healthAt(port, timeoutMs = 1500) {
  return httpJson(`http://127.0.0.1:${port}/control/health`, timeoutMs);
}

function healthMatches(health, config) {
  return !!(
    health?.ok &&
    health.json?.name === 'devmate' &&
    (!config?.instanceId || health.json.instanceId === config.instanceId)
  );
}

function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function choosePort(config, preferredPort = DEFAULT_PORT) {
  const base = Number(config?.server?.port || preferredPort || DEFAULT_PORT);
  for (let port = base; port < base + 20; port += 1) {
    const health = await healthAt(port, 600);
    if (healthMatches(health, config)) return { port, attached: true };
    if (!health.ok && await isPortFree(port)) return { port, attached: false };
  }
  throw new Error(`No free DevMate port found from ${base} to ${base + 19}`);
}

function boundedContext(value, maxChars = 200000) {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, maxChars)
  };
}

class RuntimeController {
  constructor({
    workspaceRoot,
    stateDirectory,
    gatewayEntry,
    preferredPort = DEFAULT_PORT,
    appVersion = DEFAULT_VERSION,
    hostId = 'host',
    logger = () => {},
    nodeExecutable = process.execPath,
    spawnImpl = spawn
  }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.stateDirectory = path.resolve(stateDirectory);
    this.gatewayEntry = path.resolve(gatewayEntry);
    this.preferredPort = preferredPort;
    this.appVersion = appVersion;
    this.hostId = String(hostId || 'host');
    this.logger = logger;
    this.nodeExecutable = nodeExecutable;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.owned = false;
  }

  get configFile() {
    return path.join(this.stateDirectory, 'config.json');
  }

  ensureConfig() {
    return ensurePersonalConfig({
      configFile: this.configFile,
      workspaceRoot: this.workspaceRoot,
      preferredPort: this.preferredPort,
      appVersion: this.appVersion
    });
  }

  readConfig() {
    return readJson(this.configFile, null);
  }

  updateHostContext(context) {
    return updateConfig(this.configFile, config => {
      config.hostContexts ||= {};
      config.hostContexts[this.hostId] = boundedContext({
        ...context,
        hostId: this.hostId,
        updatedAt: context?.updatedAt || now(),
        workspaceRoot: context?.workspaceRoot || this.workspaceRoot
      });
      config.activeHostId = this.hostId;
      return config;
    });
  }

  async status() {
    const config = this.ensureConfig();
    const port = Number(config.server?.port || this.preferredPort);
    const health = await healthAt(port);
    if (healthMatches(health, config)) {
      return { state: 'running', port, attached: !this.owned, owned: this.owned, health: health.json };
    }
    if (health?.ok && health.json?.name === 'devmate') {
      return { state: 'foreign', port, attached: false, owned: false, health: health.json };
    }
    return { state: 'stopped', port, attached: false, owned: false };
  }

  async start({ timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    if (!fs.statSync(this.gatewayEntry, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Bundled DevMate Gateway is missing: ${this.gatewayEntry}`);
    }
    let config = this.ensureConfig();
    const existing = await healthAt(Number(config.server.port));
    if (healthMatches(existing, config)) {
      this.owned = false;
      this.logger(`Attached to existing DevMate Gateway on port ${config.server.port}.`);
      return { started: false, attached: true, port: Number(config.server.port), health: existing.json };
    }

    const choice = await choosePort(config, this.preferredPort);
    if (choice.attached) {
      this.owned = false;
      return { started: false, attached: true, port: choice.port };
    }
    if (choice.port !== Number(config.server.port)) {
      config = updateConfig(this.configFile, current => {
        current.server ||= {};
        current.server.port = choice.port;
        return current;
      });
    }

    if (this.child && !this.child.killed) {
      try { this.child.kill(); } catch {}
      this.child = null;
    }

    this.child = this.spawnImpl(this.nodeExecutable, [this.gatewayEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DEVMATE_CONFIG: this.configFile,
        DEVMATE_PUBLIC_HEALTH_DETAILS: '0'
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.owned = true;
    this.child.stdout?.on('data', chunk => this.logger(`[gateway] ${String(chunk).trimEnd()}`));
    this.child.stderr?.on('data', chunk => this.logger(`[gateway:error] ${String(chunk).trimEnd()}`));
    this.child.on('error', error => this.logger(`Gateway process error: ${error.message}`));
    this.child.on('exit', (code, signal) => {
      this.logger(`Gateway exited code=${code} signal=${signal}`);
      this.child = null;
      this.owned = false;
    });

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const health = await healthAt(choice.port, 800);
      if (healthMatches(health, config)) {
        return { started: true, attached: false, port: choice.port, health: health.json };
      }
      if (this.child?.exitCode != null) break;
    }
    try { this.child?.kill(); } catch {}
    this.child = null;
    this.owned = false;
    throw new Error('DevMate Gateway did not become ready');
  }

  async stop() {
    if (!this.child || this.child.killed || !this.owned) {
      const status = await this.status();
      return {
        stopped: false,
        attached: status.state === 'running',
        reason: status.state === 'running' ? 'managed-by-another-host' : 'not-running'
      };
    }
    const child = this.child;
    this.child = null;
    this.owned = false;
    try { child.kill(); }
    catch (error) { return { stopped: false, reason: error.message }; }
    return { stopped: true };
  }

  async restart() {
    const stopped = await this.stop();
    if (!stopped.stopped && stopped.reason === 'managed-by-another-host') {
      return { restarted: false, attached: true, reason: stopped.reason };
    }
    return { restarted: true, ...(await this.start()) };
  }

  ownerUrl(publicOrigin = '') {
    const config = this.ensureConfig();
    const origin = String(publicOrigin || config.deployment?.publicUrl || `http://127.0.0.1:${config.server.port}`)
      .replace(/\/$/, '');
    const url = new URL(`${origin}${config.server?.mcpPath || '/mcp'}`);
    if (config.auth?.required !== false && config.auth?.token) url.searchParams.set('token', config.auth.token);
    return url.toString();
  }

  async dispose({ stopOwned = false } = {}) {
    if (stopOwned) await this.stop();
    this.child = null;
    this.owned = false;
  }
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_VERSION,
  RuntimeController,
  atomicWriteJson,
  choosePort,
  defaultSharedStateDirectory,
  ensurePersonalConfig,
  healthAt,
  healthMatches,
  migrateLegacyState,
  newPersonalConfig,
  normalizedWorkspaceRoot,
  readJson,
  resolveStateDirectory,
  updateConfig,
  workspaceRuntimeId
};
