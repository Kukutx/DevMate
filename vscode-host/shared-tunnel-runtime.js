'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { atomicWriteJson, readJson } = require('../host/runtime/config-store.js');
const { OperationCoordinator } = require('../host/runtime/operation-coordinator.js');
const { terminateChild } = require('../host/runtime/process-controller.js');
const { StartupLease, waitForStartupLease } = require('../host/runtime/startup-lease.js');
const { SpawnLayer } = require('./spawn-layer.js');
const {
  isNgrokCommand,
  normalizeProvider,
  normalizePublicUrl,
  parsePort,
  requestTarget,
  virtualHttpRequest
} = require('../tunnel-provider.js');

const RUNTIME_RECORD_VERSION = 1;
const RUNTIME_RECORD_NAME = 'tunnel.runtime.json';
const STARTUP_LOCK_NAME = 'tunnel.start.lock';
const DEFAULT_RUNTIME_LEASE_MS = 120000;
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_START_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_ATTACHED_POLL_MS = 1000;
const MAX_RUNTIME_RECORD_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_CONFIGURATION_TEXT = 4096;
const MAX_RUNTIME_LEASE_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function safePublicUrl(value) {
  try {
    return normalizePublicUrl(value || '');
  } catch {
    return '';
  }
}

function configurationUrl(value) {
  const raw = String(value || '').trim().slice(0, MAX_CONFIGURATION_TEXT);
  if (!raw) return '';
  const normalized = safePublicUrl(raw);
  return normalized || `invalid:${raw}`;
}

function runtimeRecordError(message, code, recordFile) {
  const error = new Error(message);
  error.code = code;
  error.recordFile = recordFile;
  return error;
}

function stableConfiguration(settings = {}, port = 0) {
  return {
    port: Number(port) || 0,
    provider: normalizeProvider(settings.provider || settings.tunnelProvider || 'ngrok'),
    publicUrl: configurationUrl(settings.publicUrl),
    ngrokUrl: configurationUrl(settings.ngrokUrl),
    ngrokCommandPath: String(settings.ngrokCommandPath || '').trim().slice(0, MAX_CONFIGURATION_TEXT),
    ngrokUseManagedAccount: settings.ngrokUseManagedAccount !== false,
    ngrokPoolingEnabled: settings.ngrokPoolingEnabled === true,
    ngrokTrafficPolicyFile: String(settings.ngrokTrafficPolicyFile || '').trim().slice(0, MAX_CONFIGURATION_TEXT),
    cloudflareCommandPath: String(settings.cloudflareCommandPath || '').trim().slice(0, MAX_CONFIGURATION_TEXT),
    deploymentMode: String(settings.deploymentMode || 'personal').trim().toLowerCase().slice(0, 64)
  };
}

function configurationKey(settings, port) {
  const value = stableConfiguration(settings, port);
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function runtimeRecordStale(record, { at = Date.now(), leaseMs = DEFAULT_RUNTIME_LEASE_MS } = {}) {
  if (!record || typeof record !== 'object') return true;
  if (!processAlive(record.hostPid)) return true;
  const effectiveLease = Math.max(30000, Number(record.leaseMs) || Number(leaseMs) || DEFAULT_RUNTIME_LEASE_MS);
  const heartbeat = Date.parse(record.heartbeatAt || '');
  const modified = Number(record.mtimeMs) || 0;
  const activity = Math.max(Number.isFinite(heartbeat) ? heartbeat : 0, modified);
  return !activity || at - activity >= effectiveLease;
}

function normalizeRuntimeRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const ownerId = String(record.ownerId || '').trim();
  const hostId = String(record.hostId || '').trim();
  const hostPid = Number(record.hostPid);
  const childPid = record.childPid == null ? null : Number(record.childPid);
  const port = Number(record.port);
  const rawProvider = String(record.provider || '').trim().toLowerCase();
  const provider = normalizeProvider(rawProvider);
  const key = String(record.configurationKey || '').trim().toLowerCase();
  const status = String(record.status || '').trim().toLowerCase();
  const publicUrl = safePublicUrl(record.publicUrl);
  const acquiredAt = String(record.acquiredAt || '');
  const heartbeatAt = String(record.heartbeatAt || '');
  const readyAt = record.readyAt == null ? null : String(record.readyAt);
  const leaseMs = Number(record.leaseMs);
  const valid =
    ownerId.length > 0 && ownerId.length <= 512 &&
    hostId.length > 0 && hostId.length <= 256 &&
    Number.isInteger(hostPid) && hostPid > 0 &&
    (childPid == null || (Number.isInteger(childPid) && childPid > 0)) &&
    Number.isInteger(port) && port > 0 && port <= 65535 &&
    rawProvider === provider &&
    /^[a-f0-9]{64}$/.test(key) &&
    (status === 'pending' || status === 'ready') &&
    (status === 'ready' ? !!publicUrl : !String(record.publicUrl || '').trim()) &&
    Number.isFinite(Date.parse(acquiredAt)) &&
    Number.isFinite(Date.parse(heartbeatAt)) &&
    (readyAt == null || Number.isFinite(Date.parse(readyAt))) &&
    Number.isFinite(leaseMs) && leaseMs >= 30000 && leaseMs <= MAX_RUNTIME_LEASE_MS;
  if (!valid) return null;
  return {
    ...record,
    ownerId,
    hostId,
    hostPid,
    childPid,
    port,
    provider,
    configurationKey: key,
    status,
    publicUrl,
    acquiredAt,
    heartbeatAt,
    readyAt,
    leaseMs
  };
}

function quarantineRecord(file, reason = 'invalid') {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return null;
  const destination = `${file}.${reason}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.renameSync(file, destination);
    return destination;
  } catch {
    return null;
  }
}

class SharedTunnelRecordStore {
  constructor({ stateDirectory, leaseMs = DEFAULT_RUNTIME_LEASE_MS, logger = () => {} } = {}) {
    if (!stateDirectory) throw new Error('A state directory is required for shared tunnel state');
    this.stateDirectory = path.resolve(stateDirectory);
    this.recordFile = path.join(this.stateDirectory, RUNTIME_RECORD_NAME);
    this.leaseMs = Math.min(
      MAX_RUNTIME_LEASE_MS,
      Math.max(30000, Number(leaseMs) || DEFAULT_RUNTIME_LEASE_MS)
    );
    this.logger = logger;
  }

  quarantine(reason, description) {
    const destination = quarantineRecord(this.recordFile, reason);
    if (!destination) {
      throw runtimeRecordError(
        `Could not quarantine ${description} shared tunnel record: ${this.recordFile}`,
        'DEVMATE_TUNNEL_RECORD_QUARANTINE_FAILED',
        this.recordFile
      );
    }
    this.logger(`Quarantined ${description} shared tunnel record at ${destination}.`);
    return null;
  }

  read({ includeStale = false } = {}) {
    const stat = fs.statSync(this.recordFile, { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile()) {
      throw runtimeRecordError(
        `Shared tunnel runtime record path is not a file: ${this.recordFile}`,
        'DEVMATE_TUNNEL_RECORD_PATH_INVALID',
        this.recordFile
      );
    }
    if (stat.size > MAX_RUNTIME_RECORD_BYTES) return this.quarantine('oversized', 'oversized');

    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.recordFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      return this.quarantine('invalid-json', 'malformed');
    }

    const version = Number(record?.version);
    if (Number.isInteger(version) && version > RUNTIME_RECORD_VERSION) {
      throw runtimeRecordError(
        `Shared tunnel runtime record version ${version} is newer than supported version ${RUNTIME_RECORD_VERSION}`,
        'DEVMATE_TUNNEL_RECORD_FUTURE_VERSION',
        this.recordFile
      );
    }

    const normalized = version === RUNTIME_RECORD_VERSION ? normalizeRuntimeRecord(record) : null;
    if (!normalized) return this.quarantine('invalid-record', 'invalid');

    const value = { ...normalized, mtimeMs: stat.mtimeMs };
    if (!includeStale && runtimeRecordStale(value, { leaseMs: this.leaseMs })) {
      try {
        fs.rmSync(this.recordFile, { force: true });
      } catch (error) {
        throw runtimeRecordError(
          `Could not remove stale shared tunnel record: ${error.message || error}`,
          'DEVMATE_TUNNEL_RECORD_STALE_CLEANUP_FAILED',
          this.recordFile
        );
      }
      return null;
    }
    return value;
  }

  write(ownerId, patch = {}) {
    const current = this.read();
    if (current && current.ownerId !== ownerId) {
      const error = new Error(`Shared tunnel ownership changed to ${current.ownerId || 'unknown'}`);
      error.code = 'DEVMATE_TUNNEL_OWNER_CHANGED';
      throw error;
    }
    const record = {
      version: RUNTIME_RECORD_VERSION,
      ownerId,
      hostId: String(patch.hostId || current?.hostId || 'vscode'),
      hostPid: process.pid,
      childPid: patch.childPid ?? current?.childPid ?? null,
      port: Number(patch.port ?? current?.port ?? 0),
      provider: normalizeProvider(patch.provider || current?.provider || 'ngrok'),
      configurationKey: String(patch.configurationKey || current?.configurationKey || ''),
      status: String(patch.status || current?.status || 'pending'),
      publicUrl: safePublicUrl(patch.publicUrl ?? current?.publicUrl ?? ''),
      acquiredAt: String(patch.acquiredAt || current?.acquiredAt || nowIso()),
      readyAt: patch.readyAt ?? current?.readyAt ?? null,
      heartbeatAt: nowIso(),
      leaseMs: this.leaseMs
    };
    const normalized = normalizeRuntimeRecord(record);
    if (!normalized) {
      throw runtimeRecordError(
        'Refusing to persist an invalid shared tunnel runtime record',
        'DEVMATE_TUNNEL_RECORD_WRITE_INVALID',
        this.recordFile
      );
    }
    atomicWriteJson(this.recordFile, normalized);
    return normalized;
  }

  remove(ownerId) {
    let current;
    try {
      current = this.read({ includeStale: true });
    } catch (error) {
      if (error?.code === 'DEVMATE_TUNNEL_RECORD_FUTURE_VERSION' || error?.code === 'DEVMATE_TUNNEL_RECORD_PATH_INVALID') {
        return false;
      }
      throw error;
    }
    if (!current || current.ownerId !== ownerId || Number(current.hostPid) !== process.pid) return false;
    try {
      fs.rmSync(this.recordFile, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function childActive(child) {
  return !!child && child.exitCode == null && child.killed !== true;
}

class SharedTunnelProcess extends EventEmitter {
  constructor(runtime, launch) {
    super();
    this.runtime = runtime;
    this.launch = launch;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.delegate = null;
    this.ownerId = `${runtime.hostId}-tunnel-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.attached = false;
    this.owned = false;
    this.recordOwnerId = '';
    this.watcher = null;
    this.readyTimer = null;
    this.started = false;
    this.finished = false;
    queueMicrotask(() => this.initialize());
  }

  get pid() {
    return this.delegate?.pid || null;
  }

  async initialize() {
    if (this.killed || this.finished) return this.finish(0, 'SIGTERM');
    try {
      await this.runtime.initializeProcess(this);
      this.started = true;
      if (this.killed && this.owned) this.delegate?.kill?.('SIGTERM');
      if (this.killed && this.attached) this.finish(0, 'SIGTERM');
    } catch (error) {
      this.stderr.write(`DevMate shared tunnel start failed: ${error.message || error}\n`);
      if (this.listenerCount('error') > 0) this.emit('error', error);
      this.finish(1, null);
    }
  }

  attachOwner(child, record) {
    this.delegate = child;
    this.owned = true;
    this.attached = false;
    this.recordOwnerId = record.ownerId;
    child.stdout?.on('data', chunk => this.stdout.write(chunk));
    child.stderr?.on('data', chunk => this.stderr.write(chunk));
    child.on?.('error', error => {
      this.stderr.write(`Tunnel process error: ${error.message || error}\n`);
      if (this.listenerCount('error') > 0) this.emit('error', error);
    });
    child.once?.('exit', (code, signal) => {
      this.runtime.ownerExited(this, code, signal);
      this.finish(code, signal);
    });
    this.startReadinessTimer();
  }

  attachFollower(record) {
    this.owned = false;
    this.attached = true;
    this.recordOwnerId = record.ownerId;
    this.stdout.write(`Attached to shared DevMate tunnel owned by ${record.hostId || 'another VS Code host'}.\n`);
    this.watcher = setInterval(() => {
      try {
        const current = this.runtime.store.read();
        if (!current || current.ownerId !== this.recordOwnerId) this.finish(0, null);
      } catch (error) {
        this.stderr.write(`Shared tunnel attachment ended: ${error.message || error}\n`);
        this.finish(1, null);
      }
    }, this.runtime.attachedPollMs);
    this.watcher.unref?.();
  }

  startReadinessTimer() {
    if (this.readyTimer || !this.owned || this.finished) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      void this.runtime.expirePendingOwner(this).catch(error => {
        this.stderr.write(`DevMate shared tunnel readiness cleanup failed: ${error.message || error}\n`);
      });
    }, this.runtime.readyTimeoutMs);
    this.readyTimer.unref?.();
  }

  clearReadinessTimer() {
    if (!this.readyTimer) return false;
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
    return true;
  }

  finish(code = 0, signal = null) {
    if (this.finished) return;
    this.finished = true;
    if (this.watcher) clearInterval(this.watcher);
    this.watcher = null;
    this.clearReadinessTimer();
    this.exitCode = Number.isInteger(code) ? code : null;
    this.signalCode = signal || null;
    this.stdout.end();
    this.stderr.end();
    this.runtime.processFinished(this);
    queueMicrotask(() => {
      this.emit('exit', this.exitCode, this.signalCode);
      this.emit('close', this.exitCode, this.signalCode);
    });
  }

  kill(signal = 'SIGTERM') {
    if (this.killed || this.finished) return true;
    this.killed = true;
    if (this.owned && this.delegate) {
      try {
        return this.delegate.kill?.(signal) ?? true;
      } catch {
        return false;
      }
    }
    if (this.attached || this.started) this.finish(0, signal);
    return true;
  }

  ref() {
    this.delegate?.ref?.();
    return this;
  }

  unref() {
    this.delegate?.unref?.();
    return this;
  }
}

function effectiveRequestArguments(input, options, callback) {
  if (typeof options === 'function') return { input, options: {}, callback: options };
  return { input, options: options || {}, callback };
}

function tunnelResponse(record) {
  return {
    tunnels: record?.publicUrl ? [{
      name: 'devmate-shared-tunnel',
      public_url: record.publicUrl,
      proto: 'https',
      config: { addr: `http://127.0.0.1:${record.port}` }
    }] : []
  };
}

class SharedTunnelRuntime {
  constructor({
    stateDirectory,
    configFile = '',
    childProcess,
    http,
    settings = () => ({}),
    hostId = 'vscode',
    logger = () => {},
    runtimeLeaseMs = DEFAULT_RUNTIME_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    attachedPollMs = DEFAULT_ATTACHED_POLL_MS
  } = {}) {
    if (!stateDirectory) throw new Error('A shared state directory is required');
    if (!childProcess?.spawn) throw new TypeError('A child_process-compatible module is required');
    if (!http?.request) throw new TypeError('An http-compatible module is required');
    this.stateDirectory = path.resolve(stateDirectory);
    this.configFile = configFile ? path.resolve(configFile) : path.join(this.stateDirectory, 'config.json');
    this.childProcess = childProcess;
    this.http = http;
    this.settingsGetter = settings;
    this.hostId = String(hostId || 'vscode');
    this.logger = logger;
    this.runtimeLeaseMs = Math.min(
      MAX_RUNTIME_LEASE_MS,
      Math.max(30000, Number(runtimeLeaseMs) || DEFAULT_RUNTIME_LEASE_MS)
    );
    this.heartbeatMs = Math.max(5000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.startTimeoutMs = Math.max(5000, Number(startTimeoutMs) || DEFAULT_START_TIMEOUT_MS);
    this.readyTimeoutMs = Math.max(250, Number(readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS);
    this.attachedPollMs = Math.max(250, Number(attachedPollMs) || DEFAULT_ATTACHED_POLL_MS);
    this.store = new SharedTunnelRecordStore({
      stateDirectory: this.stateDirectory,
      leaseMs: this.runtimeLeaseMs,
      logger
    });
    this.operations = new OperationCoordinator({ name: `${this.hostId}-shared-tunnel` });
    this.processes = new Set();
    this.ownedProcess = null;
    this.heartbeat = null;
    this.spawnLayer = null;
    this.requestPrevious = null;
    this.requestWrapper = null;
    this.installed = false;
    this.disposed = false;
  }

  settings() {
    return this.settingsGetter() || {};
  }

  configuredPort() {
    return Number(readJson(this.configFile, null)?.server?.port || 0);
  }

  matchForPort(port) {
    const settings = this.settings();
    return {
      port: Number(port) || 0,
      provider: normalizeProvider(settings.provider || settings.tunnelProvider || 'ngrok'),
      configurationKey: configurationKey(settings, port)
    };
  }

  recordMatches(record, match) {
    return !!(
      record &&
      Number(record.port) === Number(match.port) &&
      normalizeProvider(record.provider) === normalizeProvider(match.provider) &&
      String(record.configurationKey || '') === String(match.configurationKey || '')
    );
  }

  conflictError(record, match) {
    const error = new Error(
      `A shared DevMate tunnel is already active for port ${record.port} with different tunnel settings. ` +
      'Stop it from the owning VS Code window or restore the matching provider configuration.'
    );
    error.code = 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT';
    error.activeProvider = record.provider;
    error.requestedProvider = match.provider;
    error.activeOwnerId = record.ownerId;
    return error;
  }

  isDevMateLaunch(command, args) {
    if (!isNgrokCommand(command) || String(args?.[0] || '').toLowerCase() !== 'http') return false;
    const port = parsePort(args);
    if (!port) return false;
    const configured = this.configuredPort();
    return configured > 0 && configured === port;
  }

  install() {
    if (this.installed) return this;
    if (this.disposed) throw new Error('Shared tunnel runtime is disposed');
    let layer = null;
    try {
      layer = new SpawnLayer({
        childProcess: this.childProcess,
        name: 'devmate-shared-tunnel',
        wrap: previous => this.wrapSpawn(previous)
      }).install();
      this.spawnLayer = layer;
      this.requestPrevious = this.http.request;
      this.requestWrapper = this.wrapRequest(this.requestPrevious);
      this.http.request = this.requestWrapper;
      this.installed = true;
      return this;
    } catch (error) {
      try {
        layer?.dispose();
      } catch {}
      this.spawnLayer = null;
      this.requestPrevious = null;
      this.requestWrapper = null;
      throw error;
    }
  }

  suspendSpawn() {
    const layer = this.spawnLayer;
    this.spawnLayer = null;
    if (!layer) return { disposed: true, alreadyDisposed: true };
    return layer.dispose();
  }

  wrapSpawn(previousSpawn) {
    return (command, args, options) => {
      if (!this.isDevMateLaunch(command, args)) return previousSpawn.call(this.childProcess, command, args, options);
      const port = parsePort(args);
      const match = this.matchForPort(port);
      const active = this.store.read();
      if (active && !this.recordMatches(active, match)) throw this.conflictError(active, match);
      const processProxy = new SharedTunnelProcess(this, {
        command,
        args: Array.isArray(args) ? [...args] : [],
        options: options ? { ...options } : options,
        previousSpawn,
        match
      });
      this.processes.add(processProxy);
      return processProxy;
    };
  }

  async initializeProcess(processProxy) {
    return this.operations.run('spawn', async () => {
      if (this.disposed || processProxy.killed) {
        const error = new Error('Shared tunnel start was cancelled');
        error.code = 'DEVMATE_TUNNEL_START_CANCELLED';
        throw error;
      }
      const { match } = processProxy.launch;
      let active = this.store.read();
      if (active) {
        if (!this.recordMatches(active, match)) throw this.conflictError(active, match);
        processProxy.attachFollower(active);
        return;
      }

      const lease = new StartupLease({
        stateDirectory: this.stateDirectory,
        hostId: `${this.hostId}-tunnel`,
        lockName: STARTUP_LOCK_NAME,
        leaseMs: Math.min(30000, this.startTimeoutMs)
      });
      try {
        const acquired = await waitForStartupLease(lease, {
          timeoutMs: this.startTimeoutMs,
          onWait: () => {
            const current = this.store.read();
            if (!current) return null;
            if (!this.recordMatches(current, match)) throw this.conflictError(current, match);
            return current;
          }
        });
        if (!(acquired instanceof StartupLease)) {
          processProxy.attachFollower(acquired);
          return;
        }
        lease.assertOwned();
        active = this.store.read();
        if (active) {
          if (!this.recordMatches(active, match)) throw this.conflictError(active, match);
          processProxy.attachFollower(active);
          return;
        }
        if (processProxy.killed || this.disposed) {
          const error = new Error('Shared tunnel start was cancelled');
          error.code = 'DEVMATE_TUNNEL_START_CANCELLED';
          throw error;
        }

        let child = null;
        try {
          child = processProxy.launch.previousSpawn.call(
            this.childProcess,
            processProxy.launch.command,
            processProxy.launch.args,
            processProxy.launch.options
          );
          if (!child || typeof child.on !== 'function') {
            throw new Error('Tunnel provider did not return a process-like handle');
          }
          const record = this.store.write(processProxy.ownerId, {
            hostId: this.hostId,
            childPid: child.pid || null,
            port: match.port,
            provider: match.provider,
            configurationKey: match.configurationKey,
            status: 'pending',
            publicUrl: ''
          });
          this.ownedProcess = processProxy;
          processProxy.attachOwner(child, record);
          this.startHeartbeat();
        } catch (error) {
          if (child && childActive(child)) {
            try {
              child.kill?.('SIGTERM');
            } catch {}
          }
          this.store.remove(processProxy.ownerId);
          throw error;
        }
      } finally {
        lease.release();
      }
    });
  }

  expirePendingOwner(processProxy) {
    return this.operations.run('expire-pending', async () => {
      if (this.ownedProcess !== processProxy || processProxy.finished) {
        return { expired: false, reason: 'not-owner' };
      }
      const record = this.store.read();
      if (!record || record.ownerId !== processProxy.ownerId) {
        return { expired: false, reason: 'ownership-changed' };
      }
      if (record.status === 'ready' && record.publicUrl) {
        processProxy.clearReadinessTimer();
        return { expired: false, reason: 'ready' };
      }
      processProxy.stderr.write(
        `DevMate shared tunnel did not publish a valid HTTPS URL within ${this.readyTimeoutMs}ms; stopping it.\n`
      );
      const result = await terminateChild(processProxy.delegate, { timeoutMs: 2000, forceTimeoutMs: 1000 });
      if (this.ownedProcess === processProxy && !processProxy.finished) {
        this.stopHeartbeat();
        this.store.remove(processProxy.ownerId);
        this.ownedProcess = null;
        processProxy.finish(result.exited ? 0 : 1, processProxy.delegate?.signalCode || null);
      }
      return { expired: true, ...result };
    });
  }

  startHeartbeat() {
    if (this.heartbeat || !this.ownedProcess) return;
    this.heartbeat = setInterval(() => {
      const owner = this.ownedProcess;
      if (!owner || owner.finished || !childActive(owner.delegate)) {
        this.stopHeartbeat();
        return;
      }
      try {
        const record = this.store.read();
        if (!record || record.ownerId !== owner.ownerId) {
          owner.delegate?.kill?.('SIGTERM');
          this.stopHeartbeat();
          return;
        }
        this.store.write(owner.ownerId, { childPid: owner.delegate?.pid || null });
      } catch (error) {
        this.logger(`Shared tunnel heartbeat failed: ${error.message || error}`);
        try {
          owner.delegate?.kill?.('SIGTERM');
        } catch {}
        this.stopHeartbeat();
      }
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  stopHeartbeat() {
    if (!this.heartbeat) return false;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    return true;
  }

  ownerExited(processProxy, code, signal) {
    if (this.ownedProcess !== processProxy) return;
    this.stopHeartbeat();
    try {
      this.store.remove(processProxy.ownerId);
    } catch (error) {
      this.logger(`Could not remove shared tunnel owner record: ${error.message || error}`);
    }
    this.ownedProcess = null;
    this.logger(`Shared tunnel owner exited code=${code} signal=${signal || 'none'}.`);
  }

  processFinished(processProxy) {
    this.processes.delete(processProxy);
    if (this.ownedProcess === processProxy && !childActive(processProxy.delegate)) {
      this.stopHeartbeat();
      try {
        this.store.remove(processProxy.ownerId);
      } catch (error) {
        this.logger(`Could not remove finished shared tunnel record: ${error.message || error}`);
      }
      this.ownedProcess = null;
    }
  }

  markReady(ownerId, publicUrl) {
    const owner = this.ownedProcess;
    if (!owner || owner.ownerId !== ownerId) return null;
    const normalized = safePublicUrl(publicUrl);
    if (!normalized) return null;
    const record = this.store.write(ownerId, {
      childPid: owner.delegate?.pid || null,
      status: 'ready',
      publicUrl: normalized,
      readyAt: nowIso()
    });
    owner.clearReadinessTimer();
    return record;
  }

  captureProviderResponse(record, response) {
    const chunks = [];
    let bytes = 0;
    let oversized = false;
    response.on('data', chunk => {
      if (oversized) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_CAPTURE_BYTES) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    response.on('end', () => {
      if (oversized) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const tunnel = (payload?.tunnels || []).find(item =>
          String(item?.public_url || '').startsWith('https://') &&
          Number(String(item?.config?.addr || item?.config?.addr_url || '').match(/:(\d+)(?:\/)?$/)?.[1]) === Number(record.port)
        );
        if (tunnel?.public_url) this.markReady(record.ownerId, tunnel.public_url);
      } catch {}
    });
  }

  wrapRequest(previousRequest) {
    return (input, options, callback) => {
      const effective = effectiveRequestArguments(input, options, callback);
      const target = requestTarget(input, effective.options);
      const method = String(effective.options?.method || input?.method || 'GET').toUpperCase();
      const compatibility = target &&
        ['127.0.0.1', 'localhost', '::1'].includes(target.hostname) &&
        String(target.port || '80') === '4040' &&
        target.pathname.startsWith('/api/tunnels');
      if (!compatibility) return previousRequest(input, options, callback);

      const record = this.store.read();
      if (record) {
        const match = this.matchForPort(record.port);
        if (!this.recordMatches(record, match)) {
          return virtualHttpRequest({
            statusCode: 409,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ error: 'DevMate shared tunnel configuration conflict' }),
            onResponse: effective.callback
          });
        }
      }

      if (method === 'GET' && target.pathname === '/api/tunnels') {
        if (record?.status === 'ready' && record.publicUrl) {
          return virtualHttpRequest({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(tunnelResponse(record)),
            onResponse: effective.callback
          });
        }
        if (record && record.ownerId !== this.ownedProcess?.ownerId) {
          return virtualHttpRequest({
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ tunnels: [] }),
            onResponse: effective.callback
          });
        }
        if (record && record.ownerId === this.ownedProcess?.ownerId) {
          const capture = response => {
            this.captureProviderResponse(record, response);
            effective.callback?.(response);
          };
          return previousRequest(input, effective.options, capture);
        }
      }

      if (method === 'DELETE' && target.pathname.startsWith('/api/tunnels/')) {
        if (record && record.ownerId !== this.ownedProcess?.ownerId) {
          return virtualHttpRequest({ statusCode: 204, onResponse: effective.callback });
        }
      }
      return previousRequest(input, options, callback);
    };
  }

  status() {
    const record = this.store.read();
    return {
      installed: this.installed,
      disposed: this.disposed,
      owned: !!(record && this.ownedProcess && record.ownerId === this.ownedProcess.ownerId),
      attached: !!(record && (!this.ownedProcess || record.ownerId !== this.ownedProcess.ownerId)),
      processCount: this.processes.size,
      record
    };
  }

  dispose({ stopOwned = true } = {}) {
    return this.operations.run('dispose', async () => {
      if (this.disposed) return { disposed: true, alreadyDisposed: true };
      const owner = this.ownedProcess;
      if (owner && !stopOwned && childActive(owner.delegate)) {
        return { disposed: false, reason: 'owned-process-running' };
      }

      this.suspendSpawn();
      for (const processProxy of [...this.processes]) {
        if (!processProxy.owned) processProxy.kill('SIGTERM');
      }

      let stopped = null;
      if (owner && stopOwned && childActive(owner.delegate)) {
        stopped = await terminateChild(owner.delegate, { timeoutMs: 5000, forceTimeoutMs: 2000 });
        if (!owner.finished && stopped.exited) {
          owner.finish(owner.delegate?.exitCode ?? 0, owner.delegate?.signalCode || null);
        }
      }
      this.stopHeartbeat();
      if (owner) {
        try {
          this.store.remove(owner.ownerId);
        } catch (error) {
          this.logger(`Could not remove shared tunnel record during dispose: ${error.message || error}`);
        }
      }
      this.ownedProcess = null;
      if (this.http.request === this.requestWrapper) this.http.request = this.requestPrevious;
      this.requestPrevious = null;
      this.requestWrapper = null;
      this.installed = false;
      this.disposed = true;
      return { disposed: true, stopped };
    });
  }
}

module.exports = {
  DEFAULT_ATTACHED_POLL_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_RUNTIME_LEASE_MS,
  DEFAULT_START_TIMEOUT_MS,
  MAX_CAPTURE_BYTES,
  MAX_RUNTIME_RECORD_BYTES,
  RUNTIME_RECORD_NAME,
  RUNTIME_RECORD_VERSION,
  STARTUP_LOCK_NAME,
  SharedTunnelProcess,
  SharedTunnelRecordStore,
  SharedTunnelRuntime,
  configurationKey,
  normalizeRuntimeRecord,
  processAlive,
  runtimeRecordStale,
  stableConfiguration,
  tunnelResponse
};
