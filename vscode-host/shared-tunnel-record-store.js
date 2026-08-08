'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const { normalizeProvider, normalizePublicUrl } = require('../tunnel-provider.js');

const RUNTIME_RECORD_VERSION = 1;
const RUNTIME_RECORD_NAME = 'tunnel.runtime.json';
const DEFAULT_RUNTIME_LEASE_MS = 120000;
const MAX_RUNTIME_RECORD_BYTES = 64 * 1024;
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
  const providerValue = settings.provider !== undefined ? settings.provider : settings.tunnelProvider;
  return {
    port: Number(port) || 0,
    provider: normalizeProvider(providerValue),
    publicUrl: configurationUrl(settings.publicUrl),
    ngrokUrl: configurationUrl(settings.ngrokUrl),
    ngrokCommandPath: String(settings.ngrokCommandPath || '').trim().slice(0, MAX_CONFIGURATION_TEXT),
    ngrokUseManagedAccount: settings.ngrokUseManagedAccount !== false,
    ngrokPoolingEnabled: settings.ngrokPoolingEnabled === true,
    ngrokTrafficPolicyFile: String(settings.ngrokTrafficPolicyFile || '').trim().slice(0, MAX_CONFIGURATION_TEXT),
    cloudflareCommandPath: String(settings.cloudflareCommandPath || '').trim().slice(0, MAX_CONFIGURATION_TEXT)
  };
}

function configurationKey(settings, port) {
  return crypto.createHash('sha256').update(JSON.stringify(stableConfiguration(settings, port)), 'utf8').digest('hex');
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
  let provider;
  try {
    provider = normalizeProvider(rawProvider);
  } catch {
    return null;
  }
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
    this.leaseMs = Math.min(MAX_RUNTIME_LEASE_MS, Math.max(30000, Number(leaseMs) || DEFAULT_RUNTIME_LEASE_MS));
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
    const providerValue = patch.provider !== undefined ? patch.provider : current?.provider;
    const record = {
      version: RUNTIME_RECORD_VERSION,
      ownerId,
      hostId: String(patch.hostId || current?.hostId || 'desktop'),
      hostPid: process.pid,
      childPid: patch.childPid ?? current?.childPid ?? null,
      port: Number(patch.port ?? current?.port ?? 0),
      provider: normalizeProvider(providerValue),
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

module.exports = {
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
};