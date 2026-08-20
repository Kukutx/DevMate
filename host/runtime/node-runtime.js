'use strict';

const { spawnSync } = require('node:child_process');

const MINIMUM_NODE_MAJOR = 24;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BUFFER_BYTES = 64 * 1024;

function nodeMajor(value) {
  const match = String(value || '').trim().match(/^v?(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : 0;
}

function probeNodeRuntime(executable, {
  spawnSyncImpl = spawnSync,
  minimumMajor = MINIMUM_NODE_MAJOR,
  timeoutMs = PROBE_TIMEOUT_MS,
  env = process.env
} = {}) {
  const requestedExecutable = String(executable || '').trim();
  if (!requestedExecutable) {
    return { ok: false, requestedExecutable, reason: 'empty executable' };
  }
  const result = spawnSyncImpl(requestedExecutable, [
    '-p',
    "JSON.stringify({node:process.versions.node,execPath:process.execPath,electron:process.versions.electron||null})"
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: Math.max(1000, Number(timeoutMs) || PROBE_TIMEOUT_MS),
    killSignal: 'SIGKILL',
    maxBuffer: PROBE_MAX_BUFFER_BYTES,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
  });
  if (result.error) {
    return {
      ok: false,
      requestedExecutable,
      reason: result.error.message || String(result.error)
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      requestedExecutable,
      reason: String(result.stderr || result.stdout || `exit ${result.status}`).trim()
    };
  }
  const lines = String(result.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let payload = null;
  for (const line of lines.slice().reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && value.node) {
        payload = value;
        break;
      }
    } catch {}
  }
  if (!payload) {
    return { ok: false, requestedExecutable, reason: 'runtime probe returned no Node version' };
  }
  const major = nodeMajor(payload.node);
  if (major < minimumMajor) {
    return {
      ok: false,
      requestedExecutable,
      executable: String(payload.execPath || requestedExecutable),
      nodeVersion: String(payload.node || ''),
      electronVersion: payload.electron ? String(payload.electron) : null,
      reason: `Node ${minimumMajor}+ required; found ${payload.node}`
    };
  }
  return {
    ok: true,
    requestedExecutable,
    executable: String(payload.execPath || requestedExecutable),
    nodeVersion: String(payload.node),
    electronVersion: payload.electron ? String(payload.electron) : null
  };
}

function resolveNodeRuntime({
  preferredExecutable = '',
  processExecutable = process.execPath,
  spawnSyncImpl = spawnSync,
  minimumMajor = MINIMUM_NODE_MAJOR
} = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (value, source) => {
    const executable = String(value || '').trim();
    if (!executable) return;
    const key = process.platform === 'win32' ? executable.toLowerCase() : executable;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ executable, source });
  };

  add(preferredExecutable, 'configured');
  add('node', 'path');
  add(processExecutable, 'host');

  const attempts = [];
  for (const candidate of candidates) {
    const result = probeNodeRuntime(candidate.executable, { spawnSyncImpl, minimumMajor });
    attempts.push({ source: candidate.source, ...result });
    if (result.ok) return { ...result, source: candidate.source, attempts };
  }

  const detail = attempts.map(item => `${item.source}:${item.requestedExecutable} (${item.reason || 'unavailable'})`).join('; ');
  const error = new Error(`DevMate requires a usable Node.js ${minimumMajor}+ runtime${detail ? `: ${detail}` : ''}`);
  error.code = 'DEVMATE_NODE_RUNTIME_UNAVAILABLE';
  error.attempts = attempts;
  throw error;
}

module.exports = {
  MINIMUM_NODE_MAJOR,
  PROBE_MAX_BUFFER_BYTES,
  PROBE_TIMEOUT_MS,
  nodeMajor,
  probeNodeRuntime,
  resolveNodeRuntime
};
