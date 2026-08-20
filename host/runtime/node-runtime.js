'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gatewayRuntimeContract = require('../../shared/gateway-runtime-contract.cjs');

const MINIMUM_NODE_MAJOR = 24;
const GATEWAY_PROBE_TIMEOUT_MS = 5000;
const GATEWAY_RUNTIME_PROBE_KIND = gatewayRuntimeContract.kind;
const GATEWAY_RUNTIME_CONTRACT_VERSION = gatewayRuntimeContract.version;

function nodeMajor(value) {
  const match = String(value || '').trim().match(/^v?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : 0;
}

function jsonLines(value) {
  const out = [];
  for (const line of String(value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    } catch {}
  }
  return out;
}

function packagedGatewayCandidates(baseDirectory = __dirname) {
  return [
    path.resolve(baseDirectory, 'gateway', 'server.mjs'),
    path.resolve(baseDirectory, '..', '..', 'gateway', 'server.bundle.mjs')
  ];
}

function existingFile(candidate, statSync = fs.statSync) {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() ? candidate : '';
  } catch {
    return '';
  }
}

function resolveGatewayProbeEntry(explicitEntry = '', {
  baseDirectory = __dirname,
  statSync = fs.statSync
} = {}) {
  const explicit = String(explicitEntry || '').trim();
  if (explicit) return existingFile(path.resolve(explicit), statSync);
  for (const candidate of packagedGatewayCandidates(baseDirectory)) {
    const found = existingFile(candidate, statSync);
    if (found) return found;
  }
  return '';
}

function probeGatewayRuntime(executable, {
  gatewayEntry,
  spawnSyncImpl = spawnSync,
  minimumMajor = MINIMUM_NODE_MAJOR,
  timeoutMs = GATEWAY_PROBE_TIMEOUT_MS,
  env = process.env
} = {}) {
  const requestedExecutable = String(executable || '').trim();
  const entry = String(gatewayEntry || '').trim();
  if (!requestedExecutable) {
    return { ok: false, requestedExecutable, gatewayEntry: entry, stage: 'gateway-contract', reason: 'empty executable' };
  }
  if (!entry) {
    return { ok: false, requestedExecutable, gatewayEntry: entry, stage: 'gateway-contract', reason: 'packaged Gateway probe entry is unavailable' };
  }

  const result = spawnSyncImpl(requestedExecutable, [entry], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: Math.max(1000, Number(timeoutMs) || GATEWAY_PROBE_TIMEOUT_MS),
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
      DEVMATE_RUNTIME_PROBE: '1',
      DEVMATE_CONFIG: ''
    }
  });
  if (result.error) {
    return {
      ok: false,
      requestedExecutable,
      gatewayEntry: entry,
      stage: 'gateway-contract',
      reason: result.error.message || String(result.error)
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      requestedExecutable,
      gatewayEntry: entry,
      stage: 'gateway-contract',
      reason: String(result.stderr || result.stdout || `exit ${result.status}`).trim()
    };
  }

  const payload = jsonLines(result.stdout).reverse().find(value => value.kind === GATEWAY_RUNTIME_PROBE_KIND) || null;
  if (
    !payload?.ok ||
    payload.contractVersion !== GATEWAY_RUNTIME_CONTRACT_VERSION ||
    payload.platformCapabilities !== true
  ) {
    return {
      ok: false,
      requestedExecutable,
      gatewayEntry: entry,
      stage: 'gateway-contract',
      reason: `Gateway runtime probe did not satisfy contract v${GATEWAY_RUNTIME_CONTRACT_VERSION}`
    };
  }
  if (nodeMajor(payload.node) < minimumMajor) {
    return {
      ok: false,
      requestedExecutable,
      gatewayEntry: entry,
      stage: 'gateway-contract',
      reason: `Gateway runtime reported unsupported Node ${payload.node || 'unknown'}; Node ${minimumMajor}+ is required`
    };
  }

  return {
    ok: true,
    requestedExecutable,
    executable: String(payload.execPath || requestedExecutable),
    gatewayEntry: entry,
    stage: 'gateway-contract',
    contractVersion: payload.contractVersion,
    nodeVersion: String(payload.node),
    electronVersion: payload.electron ? String(payload.electron) : null
  };
}

function resolveNodeRuntime({
  preferredExecutable = '',
  processExecutable = process.execPath,
  spawnSyncImpl = spawnSync,
  minimumMajor = MINIMUM_NODE_MAJOR,
  gatewayEntry = resolveGatewayProbeEntry()
} = {}) {
  const requestedGatewayEntry = String(gatewayEntry || '').trim();
  const verifiedGatewayEntry = resolveGatewayProbeEntry(requestedGatewayEntry);
  if (!verifiedGatewayEntry) {
    const detail = requestedGatewayEntry ? `: ${path.resolve(requestedGatewayEntry)}` : '';
    const error = new Error(`DevMate packaged Gateway runtime probe entry is missing${detail}`);
    error.code = 'DEVMATE_GATEWAY_RUNTIME_PROBE_MISSING';
    error.gatewayEntry = requestedGatewayEntry || null;
    throw error;
  }

  const candidates = [];
  const add = (value, source) => {
    const executable = String(value || '').trim();
    if (!executable || candidates.some(item => item.executable === executable)) return;
    candidates.push({ executable, source });
  };

  // Explicit configuration is authoritative. Otherwise prefer a standalone
  // Node process whose lifecycle is independent from the desktop host. The
  // host executable remains a final fallback, but it receives no special trust.
  add(preferredExecutable, 'configured');
  add('node', 'path');
  add(processExecutable, 'host');

  const attempts = [];
  for (const candidate of candidates) {
    const probe = probeGatewayRuntime(candidate.executable, {
      gatewayEntry: verifiedGatewayEntry,
      spawnSyncImpl,
      minimumMajor
    });
    const attempt = { source: candidate.source, ...probe };
    attempts.push(attempt);
    if (!probe.ok) continue;

    return {
      ...probe,
      source: candidate.source,
      gatewayEntry: verifiedGatewayEntry,
      attempts
    };
  }

  const detail = attempts
    .map(item => `${item.source}:${item.requestedExecutable} (${item.reason || 'unavailable'})`)
    .join('; ');
  const error = new Error(`DevMate requires a Gateway-compatible Node.js ${minimumMajor}+ runtime${detail ? `: ${detail}` : ''}`);
  error.code = 'DEVMATE_GATEWAY_RUNTIME_UNAVAILABLE';
  error.attempts = attempts;
  error.gatewayEntry = verifiedGatewayEntry;
  throw error;
}

module.exports = {
  MINIMUM_NODE_MAJOR,
  GATEWAY_PROBE_TIMEOUT_MS,
  GATEWAY_RUNTIME_PROBE_KIND,
  GATEWAY_RUNTIME_CONTRACT_VERSION,
  nodeMajor,
  packagedGatewayCandidates,
  probeGatewayRuntime,
  resolveGatewayProbeEntry,
  resolveNodeRuntime
};
