'use strict';

const path = require('node:path');
const { readJson } = require('../host/runtime/config-store.js');
const { OperationCoordinator } = require('../host/runtime/operation-coordinator.js');
const { terminateChild } = require('../host/runtime/process-controller.js');
const { StartupLease, waitForStartupLease } = require('../host/runtime/startup-lease.js');
const { SpawnLayer } = require('./spawn-layer.js');
const {
  isNgrokCommand,
  normalizeProvider,
  parsePort,
  requestTarget,
  virtualHttpRequest
} = require('../tunnel-provider.js');
const {
  DEFAULT_RUNTIME_LEASE_MS,
  MAX_RUNTIME_LEASE_MS,
  MAX_RUNTIME_RECORD_BYTES,
  RUNTIME_RECORD_NAME,
  RUNTIME_RECORD_VERSION,
  SharedTunnelRecordStore,
  configurationKey,
  normalizeRuntimeRecord,
  nowIso,
  processAlive,
  runtimeRecordStale,
  safePublicUrl,
  stableConfiguration
} = require('./shared-tunnel-record-store.js');
const { SharedTunnelProcess, childActive } = require('./shared-tunnel-process.js');

const STARTUP_LOCK_NAME = 'tunnel.start.lock';
const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_START_TIMEOUT_MS = 20000;
const DEFAULT_READY_TIMEOUT_MS = 20000;
const DEFAULT_ATTACHED_POLL_MS = 1000;
const MAX_CAPTURE_BYTES = 64 * 1024;

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
      try { layer?.dispose(); } catch {}
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
            try { child.kill?.('SIGTERM'); } catch {}
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
        try { owner.delegate?.kill?.('SIGTERM'); } catch {}
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
