'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  DEFAULT_PORT,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_VERSION,
  MAX_HOST_CONTEXT_CHARS
} = require('./constants.js');
const { ensurePersonalConfig, readJson, updateConfig } = require('./config-store.js');
const { choosePort, healthAt, healthMatches } = require('./network.js');

const MAX_LAUNCH_OUTPUT_CHARS = 32768;

function now() {
  return new Date().toISOString();
}

function boundedContext(value, maxChars = MAX_HOST_CONTEXT_CHARS) {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, maxChars)
  };
}

function appendOutput(current, chunk, maxChars = MAX_LAUNCH_OUTPUT_CHARS) {
  const next = `${current || ''}${String(chunk || '')}`;
  return next.length <= maxChars ? next : next.slice(-maxChars);
}

function lastOutputLine(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || '';
}

function startupFailureDetail(launch, child) {
  const explicit = launch?.error || child?.lastError?.message;
  if (explicit) return String(explicit);
  const stderr = lastOutputLine(launch?.stderr);
  if (stderr) return stderr;
  if (launch?.exitCode != null) return `Gateway exited with code ${launch.exitCode}`;
  return '';
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
    this.lastLaunch = null;
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

  diagnosticSnapshot() {
    return {
      appVersion: this.appVersion,
      hostId: this.hostId,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node || null,
      electronVersion: process.versions.electron || null,
      workspaceRoot: this.workspaceRoot,
      stateDirectory: this.stateDirectory,
      gatewayEntry: this.gatewayEntry,
      configFile: this.configFile,
      owned: this.owned,
      lastLaunch: this.lastLaunch ? { ...this.lastLaunch } : null
    };
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
      const owned = !!this.child && !this.child.killed && this.child.exitCode == null && this.owned;
      this.owned = owned;
      this.logger(`${owned ? 'Reused owned' : 'Attached to existing'} DevMate Gateway on port ${config.server.port}.`);
      return { started: false, attached: !owned, owned, port: Number(config.server.port), health: existing.json };
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

    const launch = {
      startedAt: now(),
      readyAt: null,
      endedAt: null,
      mode: 'unknown',
      port: choice.port,
      stdout: '',
      stderr: '',
      error: null,
      exitCode: null,
      signal: null
    };
    this.lastLaunch = launch;

    let child;
    try {
      child = this.spawnImpl(this.nodeExecutable, [this.gatewayEntry], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          DEVMATE_CONFIG: this.configFile,
          DEVMATE_PUBLIC_HEALTH_DETAILS: '0'
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      launch.endedAt = now();
      launch.error = error.message || String(error);
      throw new Error(`DevMate Gateway could not be launched: ${launch.error}`);
    }

    launch.mode = child.launchMode || 'child_process';
    this.child = child;
    this.owned = true;
    child.stdout?.on('data', chunk => {
      launch.stdout = appendOutput(launch.stdout, chunk);
      this.logger(`[gateway] ${String(chunk).trimEnd()}`);
    });
    child.stderr?.on('data', chunk => {
      launch.stderr = appendOutput(launch.stderr, chunk);
      this.logger(`[gateway:error] ${String(chunk).trimEnd()}`);
    });
    child.on('error', error => {
      launch.error = error.message || String(error);
      this.logger(`Gateway process error: ${launch.error}`);
    });
    child.on('exit', (code, signal) => {
      launch.endedAt = now();
      launch.exitCode = code;
      launch.signal = signal || null;
      this.logger(`Gateway exited code=${code} signal=${signal}`);
      if (this.child === child) {
        this.child = null;
        this.owned = false;
      }
    });

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || DEFAULT_START_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const health = await healthAt(choice.port, 800);
      if (healthMatches(health, config)) {
        launch.readyAt = now();
        return { started: true, attached: false, owned: true, port: choice.port, health: health.json };
      }
      if (child.exitCode != null) break;
    }
    try { child.kill(); } catch {}
    if (this.child === child) this.child = null;
    this.owned = false;
    launch.endedAt ||= now();
    const detail = startupFailureDetail(launch, child);
    const error = new Error(`DevMate Gateway did not become ready${detail ? `: ${detail}` : ''}`);
    error.code = 'DEVMATE_GATEWAY_START_FAILED';
    error.diagnostics = this.diagnosticSnapshot();
    throw error;
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
    const exited = new Promise(resolve => {
      if (child.exitCode != null) resolve(true);
      else child.once('exit', () => resolve(true));
    });
    try { child.kill(); }
    catch (error) { return { stopped: false, reason: error.message }; }
    const completed = await Promise.race([
      exited,
      new Promise(resolve => setTimeout(() => resolve(false), 5000))
    ]);
    if (!completed && child.exitCode == null) {
      return { stopped: false, reason: 'process-exit-timeout' };
    }
    if (this.child === child) this.child = null;
    this.owned = false;
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
    if (stopOwned) {
      const result = await this.stop();
      if (!result.stopped && result.reason === 'process-exit-timeout') return result;
    }
    this.child = null;
    this.owned = false;
    return { disposed: true };
  }
}

module.exports = {
  RuntimeController,
  appendOutput,
  boundedContext,
  lastOutputLine,
  now,
  startupFailureDetail
};
