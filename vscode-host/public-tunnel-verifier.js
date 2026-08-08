'use strict';

const path = require('node:path');
const { preflightPublicMcp } = require('../host/public-mcp.js');
const {
  readJson,
  updateConfig
} = require('../shared/config-store.cjs');
const {
  hostOf,
  recordGeneration,
  successfulVerificationPatch,
  verifiedForCurrentRecord
} = require('../shared/public-ingress-verification.cjs');

const DEFAULT_POLL_MS = 5000;
const DEFAULT_RETRY_MS = 30000;
const DEFAULT_READY_GRACE_MS = 20000;

function sameGeneration(a, b) {
  return !!a && a === b;
}

function stateKey(state, record, generation = '') {
  const identity = generation || [
    String(record?.ownerId || ''),
    String(record?.provider || ''),
    String(record?.port || ''),
    String(record?.status || '')
  ].join('|');
  return `${state}|${identity}`;
}

class PublicTunnelVerifier {
  constructor({
    stateDirectory,
    tunnelStatus,
    appVersion = '0',
    logger = () => {},
    preflight = preflightPublicMcp,
    onStateChange = () => {},
    onConfigurationConflict = () => {},
    onVerified = () => {},
    onError = () => {},
    pollMs = DEFAULT_POLL_MS,
    retryMs = DEFAULT_RETRY_MS,
    readyGraceMs = DEFAULT_READY_GRACE_MS,
    now = () => Date.now()
  } = {}) {
    if (!stateDirectory) throw new Error('A shared state directory is required');
    if (typeof tunnelStatus !== 'function') throw new TypeError('tunnelStatus must be a function');
    if (typeof preflight !== 'function') throw new TypeError('preflight must be a function');
    if (typeof onConfigurationConflict !== 'function') throw new TypeError('onConfigurationConflict must be a function');
    this.stateDirectory = path.resolve(stateDirectory);
    this.configFile = path.join(this.stateDirectory, 'config.json');
    this.tunnelStatus = tunnelStatus;
    this.appVersion = String(appVersion || '0');
    this.logger = logger;
    this.preflight = preflight;
    this.onStateChange = onStateChange;
    this.onConfigurationConflict = onConfigurationConflict;
    this.onVerified = onVerified;
    this.onError = onError;
    this.pollMs = Math.max(1000, Number(pollMs) || DEFAULT_POLL_MS);
    this.retryMs = Math.max(5000, Number(retryMs) || DEFAULT_RETRY_MS);
    this.readyGraceMs = Math.max(0, Number(readyGraceMs) || 0);
    this.now = now;
    this.timer = null;
    this.inFlightGeneration = '';
    this.lastAttemptGeneration = '';
    this.nextAttemptAt = 0;
    this.lastErrorNoticeGeneration = '';
    this.lastStateKey = '';
    this.disposed = false;
  }

  readConfig() {
    return readJson(this.configFile, null, { strict: true, supportedVersion: true });
  }

  snapshot(config) {
    const port = Number(config?.server?.port || 0);
    if (!Number.isInteger(port) || port <= 0) return { status: null, record: null };
    const status = this.tunnelStatus(port);
    return { status, record: status?.record || null };
  }

  currentRecord(config) {
    const { record } = this.snapshot(config);
    return recordGeneration(record) ? record : null;
  }

  generationStillCurrent(config, generation) {
    try {
      return sameGeneration(recordGeneration(this.currentRecord(config)), generation);
    } catch {
      return false;
    }
  }

  async notifyState(state, { record = null, generation = '', error = null } = {}) {
    const key = stateKey(state, record, generation);
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    try {
      await this.onStateChange({ state, record, generation, error });
    } catch (callbackError) {
      this.logger(`Public MCP recovery state callback failed: ${callbackError.message || callbackError}`);
    }
  }

  async handleConfigurationConflict(error, config) {
    await this.notifyState('configuration-conflict', { error });
    try {
      return await this.onConfigurationConflict({ error, config });
    } catch (callbackError) {
      this.logger(`Tunnel configuration-conflict cleanup callback failed: ${callbackError.message || callbackError}`);
      return { handled: false, error: callbackError };
    }
  }

  async notifyVerified(result) {
    try {
      await this.onVerified(result);
    } catch (error) {
      this.logger(`Public MCP recovery notification failed after successful verification: ${error.message || error}`);
    }
  }

  async notifyError(payload) {
    try {
      await this.onError(payload);
    } catch (error) {
      this.logger(`Public MCP recovery error notification failed: ${error.message || error}`);
    }
  }

  async check({ force = false } = {}) {
    if (this.disposed) return { checked: false, reason: 'disposed' };
    const config = this.readConfig();
    if (!config) return { checked: false, reason: 'missing-config' };
    let snapshot;
    try {
      snapshot = this.snapshot(config);
    } catch (error) {
      if (error?.code !== 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT') throw error;
      const cleanup = await this.handleConfigurationConflict(error, config);
      return { checked: false, reason: 'configuration-conflict', error, cleanup };
    }
    const record = snapshot.record;
    const generation = recordGeneration(record);
    if (!generation) {
      const state = record?.status === 'pending' || snapshot.status?.running ? 'pending' : 'absent';
      await this.notifyState(state, { record });
      return { checked: false, reason: state === 'pending' ? 'tunnel-pending' : 'no-ready-tunnel' };
    }
    if (verifiedForCurrentRecord(config, record)) {
      await this.notifyState('verified', { record, generation });
      return { checked: false, reason: 'already-verified', generation };
    }

    await this.notifyState('unverified', { record, generation });
    const readyAt = Date.parse(record.readyAt || '');
    const now = this.now();
    if (!force && Number.isFinite(readyAt) && now - readyAt < this.readyGraceMs) {
      return { checked: false, reason: 'ready-grace', generation };
    }
    if (this.inFlightGeneration === generation) {
      return { checked: false, reason: 'in-flight', generation };
    }
    if (!force && this.lastAttemptGeneration === generation && now < this.nextAttemptAt) {
      return { checked: false, reason: 'retry-backoff', generation };
    }

    const previousHost = String(config.connection?.lastPublicHost || '').trim().toLowerCase();
    this.inFlightGeneration = generation;
    this.lastAttemptGeneration = generation;
    this.nextAttemptAt = now + this.retryMs;

    let success = null;
    let failure = null;
    try {
      const token = config.auth?.required === false ? '' : String(config.auth?.token || '');
      const test = await this.preflight({
        publicUrl: record.publicUrl,
        token,
        clientName: 'devmate-vscode-runtime-recovery',
        clientVersion: this.appVersion
      });

      const latest = this.readConfig();
      if (!latest || !this.generationStillCurrent(latest, generation)) {
        this.logger('Discarded public MCP preflight result because the tunnel generation changed during verification.');
        return { checked: true, verified: false, stale: true, generation };
      }

      const stamp = new Date(this.now()).toISOString();
      updateConfig(this.configFile, current => {
        if (!this.generationStillCurrent(current, generation)) return current;
        current.connection = {
          ...(current.connection || {}),
          ...successfulVerificationPatch(test, record.publicUrl, stamp, record)
        };
        return current;
      });

      const persisted = this.readConfig();
      const persistedRecord = persisted ? this.currentRecord(persisted) : null;
      if (
        !persisted ||
        recordGeneration(persistedRecord) !== generation ||
        !verifiedForCurrentRecord(persisted, persistedRecord)
      ) {
        this.logger('Discarded public MCP recovery success because the tunnel generation changed during persistence.');
        return { checked: true, verified: false, stale: true, generation };
      }

      this.nextAttemptAt = 0;
      this.lastErrorNoticeGeneration = '';
      const nextHost = hostOf(test.publicOrigin || record.publicUrl);
      success = {
        checked: true,
        verified: true,
        stale: false,
        generation,
        record: persistedRecord,
        test,
        changedHost: !!previousHost && previousHost !== nextHost,
        previousHost,
        publicHost: nextHost
      };
      this.logger(`Reverified public MCP after tunnel generation change: ${nextHost || record.publicUrl}, tools=${test.toolCount}.`);
    } catch (error) {
      const latest = this.readConfig();
      let current = !!latest && this.generationStillCurrent(latest, generation);
      if (current) {
        updateConfig(this.configFile, value => {
          if (!this.generationStillCurrent(value, generation)) return value;
          value.connection = {
            ...(value.connection || {}),
            lastError: String(error.message || error),
            lastErrorAt: new Date(this.now()).toISOString()
          };
          return value;
        });
        const afterFailureWrite = this.readConfig();
        current = !!afterFailureWrite && this.generationStillCurrent(afterFailureWrite, generation);
      }
      this.logger(`Public MCP recovery verification failed: ${error.message || error}`);
      failure = {
        checked: true,
        verified: false,
        stale: !current,
        generation,
        record,
        error,
        notify: current && this.lastErrorNoticeGeneration !== generation
      };
      if (failure.notify) this.lastErrorNoticeGeneration = generation;
    } finally {
      if (this.inFlightGeneration === generation) this.inFlightGeneration = '';
    }

    if (success) {
      await this.notifyState('verified', { record: success.record, generation });
      await this.notifyVerified(success);
      return success;
    }
    if (failure && !failure.stale) await this.notifyState('failed', { record, generation, error: failure.error });
    if (failure?.notify) await this.notifyError({ error: failure.error, generation, record });
    return failure || { checked: true, verified: false, stale: true, generation };
  }

  start() {
    if (this.disposed) throw new Error('PublicTunnelVerifier is disposed');
    if (this.timer) return this;
    this.timer = setInterval(() => {
      void this.check().catch(error => this.logger(`Public tunnel verifier failed: ${error.message || error}`));
    }, this.pollMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inFlightGeneration = '';
    return this;
  }

  dispose() {
    if (this.disposed) return { disposed: true, alreadyDisposed: true };
    this.stop();
    this.disposed = true;
    return { disposed: true };
  }
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_READY_GRACE_MS,
  DEFAULT_RETRY_MS,
  PublicTunnelVerifier,
  sameGeneration,
  stateKey
};
