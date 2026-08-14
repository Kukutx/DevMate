'use strict';

const path = require('node:path');
const { preflightPublicMcp, publicMcpErrorKind } = require('./public-mcp.js');
const { readJson, updateConfig } = require('../shared/config-store.cjs');
const {
  recordGeneration,
  successfulVerificationPatch,
  verifiedForCurrentRecord
} = require('../shared/public-ingress-verification.cjs');
const { StartupLease, waitForStartupLease } = require('./runtime/startup-lease.js');

const VERIFICATION_LOCK_NAME = 'public-mcp.verify.lock';
const DEFAULT_READY_TIMEOUT_MS = 45000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_EVIDENCE_MAX_AGE_MS = 30000;

function staleGenerationError() {
  const error = new Error('Public MCP verification became stale because the connection generation changed');
  error.code = 'DEVMATE_PUBLIC_MCP_STALE_GENERATION';
  return error;
}

function evidenceResult(config, record) {
  const origin = String(record?.publicUrl || config?.connection?.lastPublicOrigin || '').replace(/\/$/, '');
  return {
    publicOrigin: origin,
    mcpUrl: `${origin}/mcp`,
    sessionId: null,
    toolCount: Number(config?.connection?.lastToolCount || 0),
    server: {
      name: String(config?.connection?.lastServerName || 'devmate'),
      version: String(config?.connection?.lastServerVersion || '')
    },
    sharedEvidence: true
  };
}

function verificationEvidenceFresh(config, record, gatewayLock, maxAgeMs, at = Date.now()) {
  if (!verifiedForCurrentRecord(config, record, gatewayLock)) return false;
  const verifiedAt = Date.parse(config?.connection?.lastPreflightAt || '');
  const maximumAge = Math.max(1000, Number(maxAgeMs) || DEFAULT_EVIDENCE_MAX_AGE_MS);
  return Number.isFinite(verifiedAt) && at - verifiedAt <= maximumAge;
}

function recordVerificationFailure(configFile, currentRecord, generation, error, now = Date.now, isCurrent = () => true, currentGatewayLock = () => null, probeStartedAt = 0) {
  return updateConfig(configFile, config => {
    if (isCurrent() !== true) return config;
    const record = currentRecord();
    if (recordGeneration(record) !== generation) return config;
    const successfulAt = Date.parse(config?.connection?.lastPreflightAt || '');
    if (Number.isFinite(successfulAt) && successfulAt > Number(probeStartedAt || 0)) return config;
    config.connection = {
      ...(config.connection || {}),
      lastError: String(error?.message || error).slice(0, 2000),
      lastErrorCode: String(error?.code || 'DEVMATE_PUBLIC_MCP_FAILED'),
      lastErrorKind: publicMcpErrorKind(error),
      lastErrorAt: new Date(now()).toISOString()
    };
    return config;
  });
}

async function verifySharedPublicMcp({
  stateDirectory,
  configFile = path.join(stateDirectory, 'config.json'),
  publicUrl,
  expectedRecord,
  currentRecord,
  token = '',
  clientName = 'devmate-desktop-preflight',
  clientVersion = '0',
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxEvidenceAgeMs = DEFAULT_EVIDENCE_MAX_AGE_MS,
  preflight = preflightPublicMcp,
  logger = () => {},
  now = Date.now,
  isCurrent = () => true,
  currentGatewayLock = () => null
} = {}) {
  if (!stateDirectory) throw new Error('A shared state directory is required for public MCP verification');
  if (typeof currentRecord !== 'function') throw new TypeError('currentRecord must be a function');
  const generation = recordGeneration(expectedRecord);
  if (!generation) throw staleGenerationError();

  const inspect = () => {
    if (isCurrent() !== true) throw staleGenerationError();
    const record = currentRecord();
    if (recordGeneration(record) !== generation) throw staleGenerationError();
    const config = readJson(configFile, null, { strict: true, supportedVersion: true });
    if (!config) throw new Error('DevMate shared config is unavailable during public verification');
    return {
      config,
      record,
      verified: verifiedForCurrentRecord(config, record, currentGatewayLock()),
      fresh: verificationEvidenceFresh(config, record, currentGatewayLock(), maxEvidenceAgeMs, now())
    };
  };

  const initial = inspect();
  if (initial.fresh) {
    return { test: evidenceResult(initial.config, initial.record), generation, record: initial.record, reused: true };
  }

  const timeout = Math.max(5000, Math.min(90000, Number(readyTimeoutMs) || DEFAULT_READY_TIMEOUT_MS));
  const lease = new StartupLease({
    stateDirectory,
    hostId: clientName,
    lockName: VERIFICATION_LOCK_NAME,
    leaseMs: timeout + 15000
  });

  let acquired;
  try {
    acquired = await waitForStartupLease(lease, {
      timeoutMs: timeout + 5000,
      pollMs: 150,
      onWait: async () => {
        const snapshot = inspect();
        if (!snapshot.fresh) return null;
        return { test: evidenceResult(snapshot.config, snapshot.record), generation, record: snapshot.record, reused: true };
      }
    });
  } catch (error) {
    const latest = inspect();
    if (latest.fresh) {
      return { test: evidenceResult(latest.config, latest.record), generation, record: latest.record, reused: true };
    }
    throw error;
  }
  if (!(acquired instanceof StartupLease)) return acquired;

  try {
    const before = inspect();
    if (before.fresh) {
      return { test: evidenceResult(before.config, before.record), generation, record: before.record, reused: true };
    }

    logger(`Verifying public MCP once for shared connection generation ${generation.slice(0, 32)}...`);
    let test;
    const probeStartedAt = now();
    try {
      test = await preflight({
        publicUrl,
        token,
        clientName,
        clientVersion,
        timeoutMs: requestTimeoutMs,
        readyTimeoutMs: timeout,
        shouldContinue: () => {
          try { return recordGeneration(currentRecord()) === generation; }
          catch { return false; }
        }
      });
    } catch (error) {
      const latest = inspect();
      if (latest.fresh && Date.parse(latest.config?.connection?.lastPreflightAt || '') > probeStartedAt) {
        return { test: evidenceResult(latest.config, latest.record), generation, record: latest.record, reused: true };
      }
      recordVerificationFailure(configFile, currentRecord, generation, error, now, isCurrent, currentGatewayLock, probeStartedAt);
      throw error;
    }

    const stamp = new Date(now()).toISOString();
    inspect();
    updateConfig(configFile, config => {
      if (isCurrent() !== true) return config;
      const record = currentRecord();
      if (recordGeneration(record) !== generation) return config;
      config.connection = {
        ...(config.connection || {}),
        ...successfulVerificationPatch(test, publicUrl, stamp, record, currentGatewayLock())
      };
      return config;
    });

    const persisted = inspect();
    if (!persisted.verified) throw staleGenerationError();
    return { test, stamp, generation, record: persisted.record, reused: false };
  } finally {
    lease.release();
  }
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_EVIDENCE_MAX_AGE_MS,
  VERIFICATION_LOCK_NAME,
  evidenceResult,
  recordVerificationFailure,
  staleGenerationError,
  verificationEvidenceFresh,
  verifySharedPublicMcp
};
