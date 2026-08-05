'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { OperationCoordinator } = require('./operation-coordinator.js');
const { StartupLease, waitForStartupLease } = require('./startup-lease.js');
const { terminateChild } = require('./process-controller.js');

const DEFAULT_TUNNEL_LEASE_MS = 30000;
const DEFAULT_TUNNEL_HEARTBEAT_MS = 5000;
const DEFAULT_TUNNEL_START_TIMEOUT_MS = 20000;
const MAX_TUNNEL_RECORD_BYTES = 64 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function normalizeProvider(value) {
  return String(value || 'ngrok').trim().toLowerCase() || 'ngrok';
}

function normalizeConfigurationKey(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 24);
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

function atomicWriteJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_TUNNEL_RECORD_BYTES) {
    const error = new Error(`DevMate tunnel runtime record exceeds ${MAX_TUNNEL_RECORD_BYTES} bytes`);
    error.code = 'DEVMATE_TUNNEL_RECORD_TOO_LARGE';
    throw error;
  }
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
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
      const previous = `${file}.replace-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
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
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function readTunnelRecord(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_TUNNEL_RECORD_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return { ...value, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function tunnelRecordMatches(record, { port, provider, configurationKey }) {
  return !!(
    record &&
    Number(record.port) === Number(port) &&
    normalizeProvider(record.provider) === normalizeProvider(provider) &&
    String(record.configurationKey || '') === normalizeConfigurationKey(configurationKey)
  );
}

function tunnelRecordStale(record, {
  at = Date.now(),
  leaseMs = DEFAULT_TUNNEL_LEASE_MS
} = {}) {
  if (!record) return true;
  if (!processAlive(record.hostPid)) return true;
  const effectiveLease = Math.max(5000, Number(record.leaseMs) || Number(leaseMs) || DEFAULT_TUNNEL_LEASE_MS);
  const heartbeat = Date.parse(record.heartbeatAt || '');
  const activity = Math.max(Number.isFinite(heartbeat) ? heartbeat : 0, Number(record.mtimeMs) || 0);
  return !activity || at - activity >= effectiveLease;
}

class TunnelRuntimeCoordinator {
  constructor({
    stateDirectory,
    hostId = 'vscode',
    logger = () => {},
    leaseMs = DEFAULT_TUNNEL_LEASE_MS,
    heartbeatMs = DEFAULT_TUNNEL_HEARTBEAT_MS
  } = {}) {
    if (!stateDirectory) throw new Error('A state directory is required for tunnel coordination');
    this.stateDirectory = path.resolve(stateDirectory);
    this.recordFile = path.join(this.stateDirectory, 'tunnel.runtime.json');
    this.hostId = String(hostId || 'vscode');
    this.logger = logger;
    this.leaseMs = Math.max(5000, Number(leaseMs) || DEFAULT_TUNNEL_LEASE_MS);
    this.heartbeatMs = Math.max(1000, Number(heartbeatMs) || DEFAULT_TUNNEL_HEARTBEAT_MS);
    this.operations = new OperationCoordinator({ name: `${this.hostId}-tunnel` });
    this.child = null;
    this.ownerId = '';
    this.record = null;
    this.heartbeatTimer = null;
    this.disposed = false;
  }

  activeOwnedChild() {
    return !!this.child && this.child.exitCode == null && !!this.ownerId;
  }

  readActiveRecord(match = null) {
    const record = readTunnelRecord(this.recordFile);
    if (!record) return null;
    if (tunnelRecordStale(record, { leaseMs: this.leaseMs })) {
      try { fs.rmSync(this.recordFile, { force: true }); } catch {}
      return null;
    }
    if (match && !tunnelRecordMatches(record, match)) return null;
    return record;
  }

  writeOwnedRecord(patch = {}) {
    if (!this.ownerId) throw new Error('Tunnel runtime owner is not initialized');
    const current = readTunnelRecord(this.recordFile);
    if (current && current.ownerId !== this.ownerId && !tunnelRecordStale(current, { leaseMs: this.leaseMs })) {
      const error = new Error(`Tunnel runtime ownership changed to ${current.ownerId || 'unknown'}`);
      error.code = 'DEVMATE_TUNNEL_OWNER_CHANGED';
      throw error;
    }
    const record = {
      version: 1,
      ownerId: this.ownerId,
      hostId: this.hostId,
      hostPid: process.pid,
      childPid: this.child?.pid || null,
      acquiredAt: this.record?.acquiredAt || nowIso(),
      heartbeatAt: nowIso(),
      leaseMs: this.leaseMs,
      ...this.record,
      ...patch
    };
    atomicWriteJson(this.recordFile, record);
    this.record = record;
    return record;
  }

  removeOwnedRecord() {
    if (!this.ownerId) return false;
    const current = readTunnelRecord(this.recordFile);
    if (!current || current.ownerId !== this.ownerId || Number(current.hostPid) !== process.pid) return false;
    try {
      fs.rmSync(this.recordFile, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  startHeartbeat() {
    if (this.heartbeatTimer || !this.ownerId) return;
    this.heartbeatTimer = setInterval(() => {
      try {
        if (!this.activeOwnedChild()) {
          this.stopHeartbeat();
          this.removeOwnedRecord();
          return;
        }
        this.writeOwnedRecord();
      } catch (error) {
        this.logger(`Tunnel heartbeat failed: ${error.message || error}`);
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return false;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    return true;
  }

  start(options = {}) {
    return this.operations.run('start', () => this.startInternal(options));
  }

  async startInternal({
    port,
    provider = 'ngrok',
    configurationKey = '',
    timeoutMs = DEFAULT_TUNNEL_START_TIMEOUT_MS,
    detectExisting = null,
    launch,
    waitReady
  } = {}) {
    if (this.disposed) throw new Error('Tunnel coordinator is disposed');
    if (!Number.isInteger(Number(port)) || Number(port) <= 0) throw new Error('A valid local tunnel port is required');
    if (typeof launch !== 'function') throw new TypeError('Tunnel launch callback is required');
    if (typeof waitReady !== 'function') throw new TypeError('Tunnel readiness callback is required');
    const match = {
      port: Number(port),
      provider: normalizeProvider(provider),
      configurationKey
    };

    if (this.activeOwnedChild() && tunnelRecordMatches(this.record, match) && this.record?.publicUrl) {
      return { started: false, attached: false, owned: true, child: this.child, ...this.record };
    }

    const shared = this.readActiveRecord(match);
    if (shared?.publicUrl) {
      return { started: false, attached: true, owned: false, child: null, ...shared };
    }

    const lease = new StartupLease({
      stateDirectory: this.stateDirectory,
      hostId: `${this.hostId}-tunnel`,
      lockName: 'tunnel.start.lock',
      leaseMs: Math.max(5000, Math.min(15000, Number(timeoutMs) || DEFAULT_TUNNEL_START_TIMEOUT_MS))
    });

    try {
      const leaseResult = await waitForStartupLease(lease, {
        timeoutMs,
        onWait: () => {
          const record = this.readActiveRecord(match);
          return record?.publicUrl
            ? { started: false, attached: true, owned: false, child: null, ...record }
            : null;
        }
      });
      if (!(leaseResult instanceof StartupLease)) return leaseResult;
      lease.assertOwned();

      const afterLease = this.readActiveRecord(match);
      if (afterLease?.publicUrl) {
        return { started: false, attached: true, owned: false, child: null, ...afterLease };
      }

      if (typeof detectExisting === 'function') {
        const publicUrl = String(await detectExisting() || '').trim();
        if (publicUrl) {
          return {
            started: false,
            attached: true,
            owned: false,
            child: null,
            port: Number(port),
            provider: match.provider,
            configurationKey: normalizeConfigurationKey(configurationKey),
            publicUrl,
            externallyDetected: true
          };
        }
      }

      if (this.activeOwnedChild()) {
        const stopped = await this.stopInternal();
        if (!stopped.stopped) {
          const error = new Error(`Previous owned tunnel did not stop: ${stopped.reason || 'unknown error'}`);
          error.code = 'DEVMATE_TUNNEL_PREVIOUS_PROCESS_STUCK';
          throw error;
        }
      }

      this.ownerId = `${this.hostId}-tunnel-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
      this.record = {
        port: Number(port),
        provider: match.provider,
        configurationKey: normalizeConfigurationKey(configurationKey),
        publicUrl: ''
      };
      const child = await launch({ ownerId: this.ownerId, port: Number(port), provider: match.provider });
      if (!child || typeof child.on !== 'function') throw new Error('Tunnel launch callback did not return a process-like handle');
      this.child = child;
      this.writeOwnedRecord();
      this.startHeartbeat();
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.stopHeartbeat();
        this.removeOwnedRecord();
        this.child = null;
        this.ownerId = '';
        this.record = null;
        this.logger(`Owned tunnel exited code=${code} signal=${signal || 'none'}.`);
      });

      const publicUrl = String(await waitReady({ child, port: Number(port), provider: match.provider }) || '').trim();
      if (!publicUrl) {
        const stopped = await this.stopInternal();
        const error = new Error(`Tunnel did not expose a public URL${stopped.reason ? `; cleanup=${stopped.reason}` : ''}`);
        error.code = 'DEVMATE_TUNNEL_NOT_READY';
        throw error;
      }
      lease.assertOwned();
      const record = this.writeOwnedRecord({ publicUrl, readyAt: nowIso() });
      return { started: true, attached: false, owned: true, child, ...record };
    } finally {
      lease.release();
    }
  }

  stop() {
    return this.operations.run('stop', () => this.stopInternal());
  }

  async stopInternal() {
    const child = this.activeOwnedChild() ? this.child : null;
    if (!child) {
      const record = this.readActiveRecord();
      return {
        stopped: false,
        attached: !!record,
        reason: record ? 'managed-by-another-host' : 'not-running'
      };
    }
    const completed = await terminateChild(child, { timeoutMs: 6000, forceTimeoutMs: 2500 });
    if (!completed.exited) return { stopped: false, reason: completed.error || 'process-exit-timeout', forced: completed.forced };
    this.stopHeartbeat();
    this.removeOwnedRecord();
    if (this.child === child) this.child = null;
    this.ownerId = '';
    this.record = null;
    return { stopped: true, forced: completed.forced };
  }

  status() {
    const record = this.readActiveRecord();
    return {
      state: record ? 'running' : 'stopped',
      owned: !!(record && this.ownerId && record.ownerId === this.ownerId && this.activeOwnedChild()),
      attached: !!(record && (!this.ownerId || record.ownerId !== this.ownerId)),
      record
    };
  }

  dispose({ stopOwned = false } = {}) {
    return this.operations.run('dispose', async () => {
      if (this.disposed) return { disposed: true, alreadyDisposed: true };
      if (stopOwned) {
        const stopped = await this.stopInternal();
        if (!stopped.stopped && stopped.reason === 'process-exit-timeout') return { disposed: false, ...stopped };
      } else if (this.activeOwnedChild()) {
        return { disposed: false, reason: 'owned-process-running' };
      }
      this.stopHeartbeat();
      this.disposed = true;
      return { disposed: true };
    });
  }
}

module.exports = {
  DEFAULT_TUNNEL_HEARTBEAT_MS,
  DEFAULT_TUNNEL_LEASE_MS,
  DEFAULT_TUNNEL_START_TIMEOUT_MS,
  MAX_TUNNEL_RECORD_BYTES,
  TunnelRuntimeCoordinator,
  atomicWriteJson,
  normalizeConfigurationKey,
  normalizeProvider,
  processAlive,
  readTunnelRecord,
  tunnelRecordMatches,
  tunnelRecordStale
};
