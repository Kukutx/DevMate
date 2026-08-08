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
const DEFAULT_READY_GRACE_MS = 8000;

function sameGeneration(a, b) {
  return !!a && a === b;
}

class PublicTunnelVerifier {
  constructor({
    stateDirectory,
    tunnelStatus,
    appVersion = '0',
    logger = () => {},
    preflight = preflightPublicMcp,
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
    this.stateDirectory = path.resolve(stateDirectory);
    this.configFile = path.join(this.stateDirectory, 'config.json');
    this.tunnelStatus = tunnelStatus;
    this.appVersion = String(appVersion || '0');
    this.logger = logger;
    this.preflight = preflight;
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
    this.disposed = false;
  }

  readConfig() {
    return readJson(this.configFile, null, { strict: true, supportedVersion: true });
  }

  currentRecord(config) {
    const port = Number(config?.server?.port || 0);
    if (!Number.isInteger(port) || port <= 0) return null;
    const status = this.tunnelStatus(port);
    const record = status?.record || null;
    return recordGeneration(record) ? record : null;
  }

  generationStillCurrent(config, generation) {
    try {
      return sameGeneration(recordGeneration(this.currentRecord(config)), generation);
    } catch {
      return false;
    }
  }

  async check({ force = false } = {}) {
    if (this.disposed) return { checked: false, reason: 'disposed' };
    const config = this.readConfig();
    if (!config) return { checked: false, reason: 'missing-config' };
    const record = this.currentRecord(config);
    const generation = recordGeneration(record);
    if (!generation) return { checked: false, reason: 'no-ready-tunnel' };
    if (verifiedForCurrentRecord(config, record)) {
      return { checked: false, reason: 'already-verified', generation };
    }

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
          ...successfulVerificationPatch(test, record.publicUrl, stamp)
        };
        return current;
      });

      this.nextAttemptAt = 0;
      this.lastErrorNoticeGeneration = '';
      const nextHost = hostOf(test.publicOrigin || record.publicUrl);
      const changedHost = !!previousHost && previousHost !== nextHost;
      const result = {
        checked: true,
        verified: true,
        stale: false,
        generation,
        record,
        test,
        changedHost,
        previousHost,
        publicHost: nextHost
      };
      this.logger(`Reverified public MCP after tunnel generation change: ${nextHost || record.publicUrl}, tools=${test.toolCount}.`);
      await this.onVerified(result);
      return result;
    } catch (error) {
      const latest = this.readConfig();
      const current = !!latest && this.generationStillCurrent(latest, generation);
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
      }
      this.logger(`Public MCP recovery verification failed: ${error.message || error}`);
      if (current && this.lastErrorNoticeGeneration !== generation) {
        this.lastErrorNoticeGeneration = generation;
        await this.onError({ error, generation, record });
      }
      return { checked: true, verified: false, stale: !current, generation, error };
    } finally {
      if (this.inFlightGeneration === generation) this.inFlightGeneration = '';
    }
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
  sameGeneration
};
