'use strict';

const crypto = require('node:crypto');
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
const { OperationCoordinator } = require('./operation-coordinator.js');
const { StartupLease, waitForStartupLease } = require('./startup-lease.js');

const MAX_LAUNCH_OUTPUT_CHARS = 32768;
const CHILD_EXIT_TIMEOUT_MS = 6500;
const CHILD_FORCE_EXIT_TIMEOUT_MS = 2500;

function now() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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

function childActive(child) {
  return !!child && child.exitCode == null;
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve => child.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), Math.max(100, Number(timeoutMs) || CHILD_EXIT_TIMEOUT_MS)))
  ]);
}

async function terminateChild(child, {
  timeoutMs = CHILD_EXIT_TIMEOUT_MS,
  forceTimeoutMs = CHILD_FORCE_EXIT_TIMEOUT_MS
} = {}) {
  if (!child || child.exitCode != null) return { exited: true, forced: false };
  try {
    if (!child.killed && !child.terminating) child.kill();
  } catch (error) {
    return { exited: false, forced: false, error: error.message || String(error) };
  }
  if (await waitForChildExit(child, timeoutMs)) {
    return { exited: true, forced: !!child.forceTerminated };
  }
  try {
    if (typeof child.forceTerminate === 'function') child.forceTerminate();
    else child.kill('SIGKILL');
  } catch {}
  const exited = await waitForChildExit(child, forceTimeoutMs);
  return { exited, forced: true };
}

function requiredPath(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label} is required`);
  return path.resolve(text);
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
    this.workspaceRoot = requiredPath(workspaceRoot, 'workspaceRoot');
    this.stateDirectory = requiredPath(stateDirectory, 'stateDirectory');
    this.gatewayEntry = requiredPath(gatewayEntry, 'gatewayEntry');
    this.preferredPort = preferredPort;
    this.appVersion = appVersion;
    this.hostId = String(hostId || 'host');
    this.logger = logger;
    this.nodeExecutable = nodeExecutable;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.owned = false;
    this.phase = 'idle';
    this.disposed = false;
    this.lastLaunch = null;
    this.startupLease = null;
    this.operations = new OperationCoordinator({ name: `${this.hostId}-runtime` });
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

  activeOwnedChild() {
    return this.owned && childActive(this.child) ? this.child : null;
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
      phase: this.phase,
      disposed: this.disposed,
      owned: this.owned,
      operation: this.operations.snapshot(),
      startupLease: this.startupLease?.snapshot() || null,
      child: typeof this.child?.snapshot === 'function'
        ? this.child.snapshot()
        : this.child ? {
          pid: this.child.pid || null,
          killed: !!this.child.killed,
          exitCode: this.child.exitCode ?? null,
          signalCode: this.child.signalCode ?? null,
          launchMode: this.child.launchMode || 'child_process'
        } : null,
      lastLaunch: this.lastLaunch ? { ...this.lastLaunch } : null
    };
  }

  updateHostContext(context) {
    if (this.disposed) throw new Error('Runtime controller is disposed');
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
      const owned = !!this.activeOwnedChild();
      return {
        state: this.phase === 'stopping' && owned ? 'stopping' : 'running',
        phase: this.phase,
        port,
        attached: !owned,
        owned,
        health: health.json
      };
    }
    if (health?.ok && health.json?.name === 'devmate') {
      return { state: 'foreign', phase: this.phase, port, attached: false, owned: false, health: health.json };
    }
    if (this.phase === 'starting' || this.phase === 'stopping') {
      return { state: this.phase, phase: this.phase, port, attached: false, owned: !!this.activeOwnedChild() };
    }
    return { state: 'stopped', phase: this.phase, port, attached: false, owned: false };
  }

  start(options = {}) {
    return this.operations.run('start', () => this.startInternal(options));
  }

  async startInternal({ timeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
    if (this.disposed) throw new Error('Runtime controller is disposed');
    if (!fs.statSync(this.gatewayEntry, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Bundled DevMate Gateway is missing: ${this.gatewayEntry}`);
    }

    const totalTimeoutMs = Math.max(2000, Number(timeoutMs) || DEFAULT_START_TIMEOUT_MS);
    const deadline = Date.now() + totalTimeoutMs;
    this.phase = 'starting';
    const lease = new StartupLease({ stateDirectory: this.stateDirectory, hostId: this.hostId });
    this.startupLease = lease;

    try {
      const leaseResult = await waitForStartupLease(lease, {
        timeoutMs: totalTimeoutMs,
        onWait: async () => {
          const config = this.ensureConfig();
          const health = await healthAt(Number(config.server.port), 700);
          if (!healthMatches(health, config)) return null;
          this.owned = false;
          this.phase = 'running';
          this.logger(`Attached to DevMate Gateway started by another host on port ${config.server.port}.`);
          return {
            started: false,
            attached: true,
            owned: false,
            port: Number(config.server.port),
            health: health.json,
            converged: true
          };
        }
      });

      if (!(leaseResult instanceof StartupLease)) return leaseResult;
      lease.assertOwned();

      let config = this.ensureConfig();
      let existing = await healthAt(Number(config.server.port));
      if (healthMatches(existing, config)) {
        const owned = !!this.activeOwnedChild();
        this.owned = owned;
        this.phase = 'running';
        this.logger(`${owned ? 'Reused owned' : 'Attached to existing'} DevMate Gateway on port ${config.server.port}.`);
        return { started: false, attached: !owned, owned, port: Number(config.server.port), health: existing.json };
      }

      const choice = await choosePort(config, this.preferredPort);
      lease.assertOwned();
      if (choice.attached) {
        this.owned = false;
        this.phase = 'running';
        return { started: false, attached: true, owned: false, port: choice.port };
      }
      if (choice.port !== Number(config.server.port)) {
        config = updateConfig(this.configFile, current => {
          current.server ||= {};
          current.server.port = choice.port;
          return current;
        });
      }

      if (childActive(this.child)) {
        const terminated = await terminateChild(this.child);
        if (!terminated.exited) {
          const error = new Error('Previous DevMate Gateway process did not exit before restart');
          error.code = 'DEVMATE_PREVIOUS_GATEWAY_STUCK';
          throw error;
        }
        this.child = null;
        this.owned = false;
      }

      lease.assertOwned();
      const runtimeOwnerId = `${this.hostId}-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
      const launch = {
        startedAt: now(),
        readyAt: null,
        endedAt: null,
        mode: 'unknown',
        ownerId: runtimeOwnerId,
        pid: null,
        threadId: null,
        port: choice.port,
        stdout: '',
        stderr: '',
        error: null,
        exitCode: null,
        signal: null,
        forcedTermination: false
      };
      this.lastLaunch = launch;

      let child;
      try {
        child = this.spawnImpl(this.nodeExecutable, [this.gatewayEntry], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            DEVMATE_CONFIG: this.configFile,
            DEVMATE_PUBLIC_HEALTH_DETAILS: '0',
            DEVMATE_RUNTIME_OWNER_ID: runtimeOwnerId,
            DEVMATE_RUNTIME_PARENT_PID: String(process.pid)
          },
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        launch.endedAt = now();
        launch.error = error.message || String(error);
        const wrapped = new Error(`DevMate Gateway could not be launched: ${launch.error}`);
        wrapped.code = 'DEVMATE_GATEWAY_LAUNCH_FAILED';
        wrapped.diagnostics = this.diagnosticSnapshot();
        throw wrapped;
      }

      launch.mode = child.launchMode || 'child_process';
      launch.ownerId = child.ownerId || runtimeOwnerId;
      launch.pid = child.pid || null;
      launch.threadId = child.threadId || null;
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
        launch.forcedTermination = !!child.forceTerminated;
        this.logger(`Gateway exited code=${code} signal=${signal}`);
        if (this.child === child) {
          this.child = null;
          this.owned = false;
          if (this.phase === 'running') this.phase = 'idle';
        }
      });

      while (Date.now() < deadline) {
        lease.assertOwned();
        await delay(250);
        const health = await healthAt(choice.port, 800);
        if (healthMatches(health, config)) {
          launch.readyAt = now();
          this.phase = 'running';
          return { started: true, attached: false, owned: true, port: choice.port, health: health.json };
        }
        if (child.exitCode != null) break;
      }

      const terminated = await terminateChild(child);
      launch.forcedTermination = terminated.forced || !!child.forceTerminated;
      if (this.child === child && terminated.exited) this.child = null;
      this.owned = false;
      launch.endedAt ||= now();

      config = this.ensureConfig();
      existing = await healthAt(Number(config.server.port), 1000);
      if (healthMatches(existing, config)) {
        this.phase = 'running';
        this.logger(`Converged on DevMate Gateway started by another host on port ${config.server.port}.`);
        return {
          started: false,
          attached: true,
          owned: false,
          port: Number(config.server.port),
          health: existing.json,
          converged: true
        };
      }

      const detail = startupFailureDetail(launch, child);
      const error = new Error(`DevMate Gateway did not become ready${detail ? `: ${detail}` : ''}`);
      error.code = 'DEVMATE_GATEWAY_START_FAILED';
      error.diagnostics = this.diagnosticSnapshot();
      throw error;
    } finally {
      lease.release();
      if (this.startupLease === lease) this.startupLease = null;
      if (this.phase === 'starting') this.phase = this.activeOwnedChild() ? 'running' : 'idle';
    }
  }

  stop() {
    return this.operations.run('stop', () => this.stopInternal());
  }

  async stopInternal() {
    const child = this.activeOwnedChild();
    if (!child) {
      const status = await this.status();
      return {
        stopped: false,
        attached: status.state === 'running',
        reason: status.state === 'running' ? 'managed-by-another-host' : 'not-running'
      };
    }

    this.phase = 'stopping';
    const completed = await terminateChild(child);
    if (!completed.exited) {
      this.phase = 'error';
      return { stopped: false, reason: completed.error || 'process-exit-timeout', forced: completed.forced };
    }
    if (this.child === child) this.child = null;
    this.owned = false;
    this.phase = 'idle';

    const config = this.ensureConfig();
    const health = await healthAt(Number(config.server.port), 800);
    const attached = healthMatches(health, config);
    return { stopped: true, forced: completed.forced, attached };
  }

  restart() {
    return this.operations.run('restart', async () => {
      if (this.disposed) throw new Error('Runtime controller is disposed');
      const stopped = await this.stopInternal();
      if (!stopped.stopped && stopped.reason === 'managed-by-another-host') {
        return { restarted: false, attached: true, reason: stopped.reason };
      }
      return { restarted: true, ...(await this.startInternal()) };
    });
  }

  ownerUrl(publicOrigin = '') {
    const config = this.ensureConfig();
    const origin = String(publicOrigin || config.deployment?.publicUrl || `http://127.0.0.1:${config.server.port}`)
      .replace(/\/$/, '');
    const url = new URL(`${origin}${config.server?.mcpPath || '/mcp'}`);
    if (config.auth?.required !== false && config.auth?.token) url.searchParams.set('token', config.auth.token);
    return url.toString();
  }

  dispose({ stopOwned = false } = {}) {
    return this.operations.run('dispose', async () => {
      if (this.disposed) return { disposed: true, alreadyDisposed: true };
      if (stopOwned) {
        const result = await this.stopInternal();
        if (!result.stopped && result.reason === 'process-exit-timeout') return result;
      } else if (this.activeOwnedChild()) {
        return { disposed: false, reason: 'owned-process-running' };
      }
      this.child = null;
      this.owned = false;
      this.phase = 'disposed';
      this.disposed = true;
      return { disposed: true };
    });
  }
}

module.exports = {
  CHILD_EXIT_TIMEOUT_MS,
  CHILD_FORCE_EXIT_TIMEOUT_MS,
  RuntimeController,
  appendOutput,
  boundedContext,
  childActive,
  delay,
  lastOutputLine,
  now,
  startupFailureDetail,
  terminateChild,
  waitForChildExit
};
