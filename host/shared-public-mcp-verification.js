'use strict';

const path = require('node:path');
const { preflightPublicMcp, publicMcpErrorKind } = require('./public-mcp.js');
const { authenticationMode, authenticationPolicyGeneration } = require('../shared/auth-config.cjs');
const { readJson, updateConfig } = require('../shared/config-store.cjs');
const { connectionPolicySnapshot } = require('../shared/instance-config.cjs');
const {
  recordGeneration,
  runtimeMatchesConnection,
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

function lifecycleStoppedError() {
  const error = new Error('Public MCP verification was cancelled because the shared DevMate lifecycle is stopped');
  error.code = 'DEVMATE_PUBLIC_MCP_LIFECYCLE_STOPPED';
  return error;
}

function publicAuthenticationRequiredError(config) {
  const mode = authenticationMode(config?.auth?.mode);
  const error = new Error(`Public MCP verification requires OAuth; authentication mode ${mode} is loopback-only`);
  error.code = 'DEVMATE_PUBLIC_MCP_AUTH_REQUIRED';
  error.authMode = mode;
  return error;
}

function authPolicySnapshot(config) {
  return Object.freeze({
    mode: authenticationMode(config?.auth?.mode),
    generation: authenticationPolicyGeneration(config)
  });
}

function authPolicyMatches(config, expected) {
  if (!expected) return true;
  const current = authPolicySnapshot(config);
  return current.mode === expected.mode && current.generation === expected.generation;
}

function authPolicyChangedError(expected, config) {
  const current = authPolicySnapshot(config);
  const error = new Error('Public MCP verification was cancelled because the authentication policy changed');
  error.code = 'DEVMATE_PUBLIC_MCP_AUTH_POLICY_CHANGED';
  error.expectedAuthMode = expected?.mode || null;
  error.expectedAuthGeneration = expected?.generation ?? null;
  error.currentAuthMode = current.mode;
  error.currentAuthGeneration = current.generation;
  return error;
}

function connectionPolicyMatches(config, expected) {
  if (!expected) return true;
  const current = connectionPolicySnapshot(config);
  return current.provider === expected.provider &&
    current.publicUrl === expected.publicUrl &&
    current.generation === expected.generation;
}

function connectionPolicyChangedError(expected, config) {
  const current = connectionPolicySnapshot(config);
  const error = new Error('Public MCP verification was cancelled because the connection policy changed');
  error.code = 'DEVMATE_PUBLIC_MCP_CONNECTION_POLICY_CHANGED';
  error.expectedConnectionProvider = expected?.provider || null;
  error.expectedConnectionPublicUrl = expected?.publicUrl || '';
  error.expectedConnectionGeneration = expected?.generation ?? null;
  error.currentConnectionProvider = current.provider;
  error.currentConnectionPublicUrl = current.publicUrl;
  error.currentConnectionGeneration = current.generation;
  return error;
}

function connectionPolicyMismatchError(config, record) {
  const match = runtimeMatchesConnection(config, record);
  const error = new Error(`Public MCP verification cannot use a tunnel that does not match the current connection policy: ${match.reason || 'policy mismatch'}`);
  error.code = 'DEVMATE_PUBLIC_MCP_CONNECTION_POLICY_MISMATCH';
  return error;
}

function evidenceResult(config, record) {
  const origin = String(record?.publicUrl || config?.connection?.lastPublicOrigin || '').replace(/\/$/, '');
  return {
    publicOrigin: origin,
    mcpUrl: `${origin}/mcp`,
    sessionId: null,
    toolCount: Number(config?.connection?.lastToolCount || 0),
    toolCallVerified: config?.connection?.lastToolCallVerified === true,
    probeTool: String(config?.connection?.lastProbeTool || ''),
    server: {
      name: String(config?.connection?.lastServerName || 'devmate'),
      version: String(config?.connection?.lastServerVersion || '')
    },
    sharedEvidence: true
  };
}

function verificationEvidenceFresh(config, record, gatewayLock, maxAgeMs, at = Date.now()) {
  if (config?.lifecycle?.desiredState !== 'running') return false;
  if (!verifiedForCurrentRecord(config, record, gatewayLock)) return false;
  const verifiedAt = Date.parse(config?.connection?.lastPreflightAt || '');
  const maximumAge = Math.max(1000, Number(maxAgeMs) || DEFAULT_EVIDENCE_MAX_AGE_MS);
  return Number.isFinite(verifiedAt) && at - verifiedAt <= maximumAge;
}

function recordVerificationFailure(
  configFile,
  currentRecord,
  generation,
  error,
  now = Date.now,
  isCurrent = () => true,
  currentGatewayLock = () => null,
  probeStartedAt = 0,
  expectedAuthPolicy = null,
  expectedConnectionPolicy = null
) {
  return updateConfig(configFile, config => {
    if (isCurrent() !== true || config?.lifecycle?.desiredState !== 'running') return config;
    if (!authPolicyMatches(config, expectedAuthPolicy)) return config;
    if (!connectionPolicyMatches(config, expectedConnectionPolicy)) return config;
    const record = currentRecord();
    if (recordGeneration(record) !== generation || !runtimeMatchesConnection(config, record).matches) return config;
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

  const inspect = (expectedAuthPolicy = null, expectedConnectionPolicy = null) => {
    if (isCurrent() !== true) throw staleGenerationError();
    const record = currentRecord();
    if (recordGeneration(record) !== generation) throw staleGenerationError();
    const config = readJson(configFile, null, { strict: true, supportedVersion: true });
    if (!config) throw new Error('DevMate shared config is unavailable during public verification');
    if (config.lifecycle?.desiredState !== 'running') throw lifecycleStoppedError();
    if (expectedAuthPolicy && !authPolicyMatches(config, expectedAuthPolicy)) {
      throw authPolicyChangedError(expectedAuthPolicy, config);
    }
    if (expectedConnectionPolicy && !connectionPolicyMatches(config, expectedConnectionPolicy)) {
      throw connectionPolicyChangedError(expectedConnectionPolicy, config);
    }
    if (!runtimeMatchesConnection(config, record).matches) throw connectionPolicyMismatchError(config, record);
    return {
      config,
      record,
      authPolicy: authPolicySnapshot(config),
      connectionPolicy: connectionPolicySnapshot(config),
      verified: verifiedForCurrentRecord(config, record, currentGatewayLock()),
      fresh: verificationEvidenceFresh(config, record, currentGatewayLock(), maxEvidenceAgeMs, now())
    };
  };

  const initial = inspect();
  const expectedAuthPolicy = initial.authPolicy;
  const expectedConnectionPolicy = initial.connectionPolicy;
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
        const snapshot = inspect(expectedAuthPolicy, expectedConnectionPolicy);
        if (!snapshot.fresh) return null;
        return { test: evidenceResult(snapshot.config, snapshot.record), generation, record: snapshot.record, reused: true };
      }
    });
  } catch (error) {
    if (
      error?.code === 'DEVMATE_PUBLIC_MCP_AUTH_REQUIRED' ||
      error?.code === 'DEVMATE_PUBLIC_MCP_AUTH_POLICY_CHANGED' ||
      error?.code === 'DEVMATE_PUBLIC_MCP_CONNECTION_POLICY_CHANGED' ||
      error?.code === 'DEVMATE_PUBLIC_MCP_CONNECTION_POLICY_MISMATCH' ||
      error?.code === 'DEVMATE_PUBLIC_MCP_LIFECYCLE_STOPPED'
    ) throw error;
    const latest = inspect(expectedAuthPolicy, expectedConnectionPolicy);
    if (latest.fresh) {
      return { test: evidenceResult(latest.config, latest.record), generation, record: latest.record, reused: true };
    }
    throw error;
  }
  if (!(acquired instanceof StartupLease)) return acquired;

  try {
    const before = inspect(expectedAuthPolicy, expectedConnectionPolicy);
    if (before.fresh) {
      return { test: evidenceResult(before.config, before.record), generation, record: before.record, reused: true };
    }

    logger(`Verifying public MCP once for shared connection generation ${generation.slice(0, 32)} auth=${expectedAuthPolicy.mode}:${expectedAuthPolicy.generation} connection=${expectedConnectionPolicy.generation}...`);
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
          try {
            if (recordGeneration(currentRecord()) !== generation) return false;
            const currentConfig = readJson(configFile, null, { strict: true, supportedVersion: true });
            return currentConfig?.lifecycle?.desiredState === 'running' &&
              authPolicyMatches(currentConfig, expectedAuthPolicy) &&
              connectionPolicyMatches(currentConfig, expectedConnectionPolicy) &&
              runtimeMatchesConnection(currentConfig, currentRecord()).matches;
          } catch {
            return false;
          }
        }
      });
    } catch (error) {
      const latest = inspect(expectedAuthPolicy, expectedConnectionPolicy);
      if (latest.fresh && Date.parse(latest.config?.connection?.lastPreflightAt || '') > probeStartedAt) {
        return { test: evidenceResult(latest.config, latest.record), generation, record: latest.record, reused: true };
      }
      recordVerificationFailure(
        configFile,
        currentRecord,
        generation,
        error,
        now,
        isCurrent,
        currentGatewayLock,
        probeStartedAt,
        expectedAuthPolicy,
        expectedConnectionPolicy
      );
      throw error;
    }

    const stamp = new Date(now()).toISOString();
    inspect(expectedAuthPolicy, expectedConnectionPolicy);
    updateConfig(configFile, config => {
      if (isCurrent() !== true || config?.lifecycle?.desiredState !== 'running') return config;
      if (!authPolicyMatches(config, expectedAuthPolicy)) return config;
      if (!connectionPolicyMatches(config, expectedConnectionPolicy)) return config;
      const record = currentRecord();
      if (recordGeneration(record) !== generation || !runtimeMatchesConnection(config, record).matches) return config;
      config.connection = {
        ...(config.connection || {}),
        ...successfulVerificationPatch(
          test,
          publicUrl,
          stamp,
          record,
          currentGatewayLock(),
          expectedAuthPolicy.mode,
          expectedAuthPolicy.generation,
          expectedConnectionPolicy.generation
        )
      };
      return config;
    });

    const persisted = inspect(expectedAuthPolicy, expectedConnectionPolicy);
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
  authPolicyChangedError,
  authPolicyMatches,
  authPolicySnapshot,
  connectionPolicyChangedError,
  connectionPolicyMatches,
  connectionPolicyMismatchError,
  evidenceResult,
  lifecycleStoppedError,
  publicAuthenticationRequiredError,
  recordVerificationFailure,
  staleGenerationError,
  verificationEvidenceFresh,
  verifySharedPublicMcp
};
