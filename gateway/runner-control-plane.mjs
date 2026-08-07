import crypto from 'node:crypto';
import path from 'node:path';
import { audit, mutateConfig, readConfig, redactSensitiveString } from './local-shared.mjs';
import { readDurableNamespace } from './durable-state.mjs';
import { consumeFixedWindow } from './fixed-window-rate-limit.mjs';
import { hostAllowed, remoteAddress } from './http-host-policy.mjs';
import { preflightQueuedJob } from './job-preflight.mjs';
import { claimExternalJob } from './external-job-claim.mjs';
import {
  completeJob,
  deferJob,
  failJob,
  getJob,
  heartbeatRunner,
  registerRunner,
  renewJobLease
} from './job-queue.mjs';
import {
  consumeRunnerClaim,
  renewRunnerClaim,
  revokeRunnerClaim,
  validateRunnerClaim
} from './runner-claim-fencing.mjs';
import { incrementCounter, observeDuration } from './observability.mjs';
import {
  RUNNER_PROTOCOL_VERSION,
  normalizeRunnerControlConfig,
  touchRunnerCredential,
  verifyRunnerToken
} from './runner-access.mjs';

const INSTALLED = Symbol.for('devmate.runnerControlPlaneInstalled');
const rateWindows = new Map();
const PREFIX = '/runner/v1';
const BLOCKED_ARTIFACT_SEGMENTS = new Set([
  '.git', '.env', 'secrets', 'secret', 'credentials', 'credential',
  'private-key', 'private_keys', 'service-account', 'service_accounts'
]);
const BLOCKED_ARTIFACT_EXTENSIONS = new Set([
  '.pem', '.key', '.pfx', '.p12', '.db', '.sqlite', '.sqlite3', '.log'
]);

function requestError(message, code = 'invalid_runner_request') {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function requestInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw requestError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function requestUrl(req) {
  try { return new URL(req.url || '/', 'http://localhost'); }
  catch { return null; }
}

function bearerToken(req) {
  const authorization = String(req.headers?.authorization || '');
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function consumeRate(id, limit) {
  return consumeFixedWindow(rateWindows, id, limit, { maxEntries: 10_000 }).allowed;
}

function json(res, status, payload, requestId) {
  const body = JSON.stringify({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId, ...payload });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-devmate-request-id': requestId,
    'x-devmate-runner-protocol': String(RUNNER_PROTOCOL_VERSION)
  });
  res.end(body);
}

async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`Runner request exceeds ${maxBytes} bytes`);
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`Runner request exceeds ${maxBytes} bytes`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw requestError('Runner request body must be valid JSON', 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw requestError('Runner request body must be a JSON object');
  }
  return body;
}

function stringArray(value, label, fallback) {
  const source = value === undefined ? fallback : value;
  if (!Array.isArray(source)) throw requestError(`${label} must be an array of strings`);
  const output = [];
  const seen = new Set();
  for (const item of source) {
    if (typeof item !== 'string' || !item.trim()) throw requestError(`${label} must contain only non-empty strings`);
    const clean = item.trim();
    if (!seen.has(clean)) {
      seen.add(clean);
      output.push(clean);
    }
  }
  return output;
}

function scopedSubset(reported, allowed, label, { required = true } = {}) {
  const values = stringArray(reported, label, allowed);
  if (required && !values.length) throw requestError(`${label} must contain at least one value`);
  const permitted = new Set(allowed);
  const rejected = values.filter(value => !permitted.has(value));
  if (rejected.length) throw requestError(`${label} contains values outside credential scope: ${rejected.join(', ')}`);
  return values;
}

function optionalText(value, label, maxLength = 100) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw requestError(`${label} must be a string`);
  if (value.length > maxLength) throw requestError(`${label} must be at most ${maxLength} characters`);
  return value;
}

function runnerLabels(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestError('runner.labels must be an object');
  const entries = Object.entries(value);
  if (entries.length > 100) throw requestError('runner.labels supports at most 100 entries');
  const labels = {};
  for (const [key, item] of entries) {
    if (!key || key.length > 100) throw requestError('runner label keys must be 1-100 characters');
    if (!['string', 'number', 'boolean'].includes(typeof item) || (typeof item === 'number' && !Number.isFinite(item))) {
      throw requestError(`runner label ${key} must be a string, finite number, or boolean`);
    }
    if (typeof item === 'string' && item.length > 500) throw requestError(`runner label ${key} must be at most 500 characters`);
    labels[key] = item;
  }
  return labels;
}

function runnerRegistration(principal, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw requestError('runner must be an object');
  const capabilities = scopedSubset(body.capabilities, principal.capabilities, 'runner.capabilities')
    .map(value => value.toLowerCase());
  if (!capabilities.includes('core') || !capabilities.includes('external')) {
    throw requestError('runner.capabilities must explicitly include core and external');
  }
  const workspaceIds = scopedSubset(body.workspaceIds, principal.workspaceIds, 'runner.workspaceIds');
  const maxConcurrent = requestInteger(body.maxConcurrent, principal.maxConcurrent, 1, principal.maxConcurrent, 'runner.maxConcurrent');
  return {
    id: principal.id,
    name: principal.name,
    capabilities,
    workspaceIds,
    maxConcurrent,
    version: optionalText(body.version, 'runner.version'),
    platform: optionalText(body.platform, 'runner.platform'),
    arch: optionalText(body.arch, 'runner.arch'),
    labels: runnerLabels(body.labels)
  };
}

function executionEnvelope(job, claim = null) {
  const store = readDurableNamespace('jobs', { jobs: [] });
  const internal = Array.isArray(store?.jobs) ? store.jobs.find(item => item.id === job.id) : null;
  return {
    ...job,
    ...(claim ? { claim } : {}),
    artifactPaths: Array.isArray(internal?.artifactPaths) ? [...internal.artifactPaths] : []
  };
}

function claimProof(body, jobId, runnerId) {
  if (body.claimGeneration === undefined || body.claimToken === undefined) {
    throw requestError(`Runner claim proof is required for job ${jobId}`, 'claim_fence_proof_required');
  }
  if (typeof body.claimGeneration !== 'number' || !Number.isInteger(body.claimGeneration) || body.claimGeneration < 1) {
    throw requestError('claimGeneration must be a positive integer', 'claim_fence_proof_required');
  }
  if (typeof body.claimToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.claimToken)) {
    throw requestError('claimToken must be the claim token returned by the control plane', 'claim_fence_proof_required');
  }
  return { jobId, runnerId, generation: body.claimGeneration, token: body.claimToken };
}

function strictBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw requestError(`${label} must be a boolean`);
  return value;
}

function sanitize(value, key = '', depth = 0) {
  if (depth > 10) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) return 'redacted';
  if (typeof value === 'string') return redactSensitiveString(value).slice(0, 20000);
  if (Array.isArray(value)) return value.slice(0, 500).map(item => sanitize(item, key, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 500)
        .map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)])
    );
  }
  return String(value).slice(0, 1000);
}

function sanitizeResult(value) {
  const result = sanitize(value ?? null);
  const serialized = JSON.stringify(result ?? null);
  if (Buffer.byteLength(serialized, 'utf8') <= 256 * 1024) return result;
  return {
    truncated: true,
    preview: redactSensitiveString(serialized.slice(0, 120000))
  };
}

function artifactPathAllowed(relative) {
  if (!relative || relative.includes('\0') || relative.startsWith('/') || /^[a-z]:\//i.test(relative) || relative.startsWith('//')) return false;
  const parts = relative.split('/').filter(Boolean);
  if (!parts.length || parts.some(part =>
    part === '.' || part === '..' || part.startsWith('.') || BLOCKED_ARTIFACT_SEGMENTS.has(part.toLowerCase())
  )) return false;
  return !BLOCKED_ARTIFACT_EXTENSIONS.has(path.posix.extname(parts.at(-1) || '').toLowerCase());
}

function sanitizeArtifacts(values, runnerId, workspaceId) {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw requestError('artifacts must be an array');
  const output = [];
  const seen = new Set();
  for (const item of values.slice(0, 100)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw requestError('artifact entries must be objects');
    if (typeof item.path !== 'string') throw requestError('artifact.path must be a string');
    const relative = item.path.replace(/\\/g, '/');
    if (!artifactPathAllowed(relative) || seen.has(relative)) continue;
    seen.add(relative);
    const bytes = item.bytes === undefined ? 0 : item.bytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0 || !Number.isSafeInteger(bytes)) {
      throw requestError('artifact.bytes must be a non-negative safe integer');
    }
    let sha256 = null;
    if (item.sha256 !== undefined && item.sha256 !== null) {
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
        throw requestError('artifact.sha256 must be a 64-character hexadecimal SHA-256 digest');
      }
      sha256 = item.sha256.toLowerCase();
    }
    let modifiedAt = null;
    if (item.modifiedAt !== undefined && item.modifiedAt !== null) {
      if (typeof item.modifiedAt !== 'string' || !Number.isFinite(Date.parse(item.modifiedAt))) {
        throw requestError('artifact.modifiedAt must be a valid date-time string');
      }
      modifiedAt = new Date(item.modifiedAt).toISOString();
    }
    output.push({
      workspaceId: workspaceId || null,
      path: relative.slice(0, 2000),
      bytes,
      modifiedAt,
      sha256,
      remote: true,
      runnerId
    });
  }
  return output;
}

function classifyPreflight(error) {
  const message = String(error?.message || error);
  if (error?.code === 'approval_required') return { status: 'waiting_approval', retryable: true };
  if (/requires a lease|is leased by/i.test(message)) return { status: 'blocked_lease', retryable: true };
  return { status: null, retryable: false };
}

function touchCredentialBestEffort(runnerId) {
  try {
    const preview = normalizeRunnerControlConfig(readConfig());
    if (!touchRunnerCredential(preview, runnerId)) return false;
    mutateConfig(current => {
      normalizeRunnerControlConfig(current);
      touchRunnerCredential(current, runnerId);
      return current;
    }, { retries: 4 });
    return true;
  } catch {
    return false;
  }
}

function consumeClaimBestEffort(proof) {
  try {
    consumeRunnerClaim(proof);
    return true;
  } catch {
    return false;
  }
}

async function routeRequest(req, res, url, config, principal, body, requestId) {
  const pathName = url.pathname;
  let runner = null;

  if (pathName === `${PREFIX}/heartbeat` || pathName === `${PREFIX}/jobs/claim`) {
    const registration = body.runner === undefined ? body : body.runner;
    runner = registerRunner(runnerRegistration(principal, registration));
  } else {
    try { heartbeatRunner(principal.id); } catch {}
  }

  if (pathName === `${PREFIX}/heartbeat`) {
    return json(res, 200, { runner, serverTime: new Date().toISOString() }, requestId);
  }

  if (pathName === `${PREFIX}/jobs/claim`) {
    const leaseSeconds = requestInteger(body.leaseSeconds, 60, 15, 300, 'leaseSeconds');
    const claimed = claimExternalJob({ runnerId: principal.id, leaseSeconds });
    const job = claimed?.job || null;
    if (!job) return json(res, 200, { runner, job: null }, requestId);
    try {
      preflightQueuedJob(job);
      return json(res, 200, { runner, job: executionEnvelope(job, claimed.claim) }, requestId);
    } catch (error) {
      try { revokeRunnerClaim(job.id); } catch {}
      const classification = classifyPreflight(error);
      if (classification.status) {
        deferJob({
          id: job.id,
          runnerId: principal.id,
          status: classification.status,
          error: error.message,
          delayMs: 5000
        });
      } else {
        failJob({
          id: job.id,
          runnerId: principal.id,
          error: error.message,
          retryable: classification.retryable
        });
      }
      return json(res, 200, {
        runner,
        job: null,
        deferredJobId: job.id,
        reason: redactSensitiveString(error.message)
      }, requestId);
    }
  }

  const match = pathName.match(/^\/runner\/v1\/jobs\/([^/]+)\/(renew|complete|fail|cancelled)$/);
  if (!match) {
    return json(res, 404, {
      error: 'Runner control endpoint not found',
      code: 'not_found'
    }, requestId);
  }
  let id;
  try { id = decodeURIComponent(match[1]); }
  catch { throw requestError('Runner job identifier is not valid URL encoding'); }
  const action = match[2];
  const proof = claimProof(body, id, principal.id);
  validateRunnerClaim(proof);

  if (action === 'renew') {
    const leaseSeconds = requestInteger(body.leaseSeconds, 60, 15, 300, 'leaseSeconds');
    const renewed = renewJobLease({ id, runnerId: principal.id, leaseSeconds });
    if (!renewed) {
      revokeRunnerClaim(id);
      return json(res, 409, {
        error: 'Runner no longer owns this running job',
        code: 'job_not_owned'
      }, requestId);
    }
    const job = getJob(id);
    renewRunnerClaim({ ...proof, leaseExpiresAt: job.leaseExpiresAt });
    return json(res, 200, {
      renewed: true,
      cancelRequested: !!job.cancelRequestedAt,
      leaseExpiresAt: job.leaseExpiresAt
    }, requestId);
  }

  if (action === 'complete') {
    const running = getJob(id);
    const job = completeJob({
      id,
      runnerId: principal.id,
      result: sanitizeResult(body.result),
      artifacts: sanitizeArtifacts(body.artifacts, principal.id, running.workspaceId)
    });
    consumeClaimBestEffort(proof);
    return json(res, 200, { job }, requestId);
  }

  const retryable = action === 'fail' ? strictBoolean(body.retryable, true, 'retryable') : false;
  const job = failJob({
    id,
    runnerId: principal.id,
    error: redactSensitiveString(String(
      body.error || (action === 'cancelled'
        ? 'Runner cancelled execution'
        : 'Runner execution failed')
    )).slice(0, 4000),
    retryable
  });
  consumeClaimBestEffort(proof);
  return json(res, 200, { job }, requestId);
}

export function runnerControlListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('HTTP listener must be a function');
  return async function devmateRunnerControl(req, res) {
    const url = requestUrl(req);
    if (!url || (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))) return listener(req, res);
    const started = Date.now();
    const requestId = `runner-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      const config = normalizeRunnerControlConfig(readConfig());
      if (!config.runnerControl.enabled) {
        return json(res, 404, {
          error: 'External runner control plane is disabled',
          code: 'runner_control_disabled'
        }, requestId);
      }
      if (req.method !== 'POST') {
        return json(res, 405, {
          error: 'Runner control endpoints require POST',
          code: 'method_not_allowed'
        }, requestId);
      }
      if (String(req.headers?.['x-devmate-runner-protocol'] || '') !== String(RUNNER_PROTOCOL_VERSION)) {
        return json(res, 426, {
          error: `Runner protocol ${RUNNER_PROTOCOL_VERSION} is required`,
          code: 'protocol_version_required'
        }, requestId);
      }
      if (!hostAllowed(req, config)) {
        return json(res, 421, {
          error: 'Request host is not allowed',
          code: 'host_not_allowed'
        }, requestId);
      }
      req.setTimeout?.(config.production?.requestTimeoutMs || 900000);
      const preauthKey = `preauth:${remoteAddress(req) || 'unknown'}`;
      if (!consumeRate(preauthKey, Math.max(120, config.runnerControl.requestsPerMinute * 2))) {
        return json(res, 429, {
          error: 'Runner authentication rate limit exceeded',
          code: 'rate_limited'
        }, requestId);
      }
      const principal = verifyRunnerToken(bearerToken(req), config);
      if (!principal) {
        return json(res, 401, {
          error: 'Invalid runner credential',
          code: 'unauthorized'
        }, requestId);
      }
      if (!consumeRate(principal.id, config.runnerControl.requestsPerMinute)) {
        return json(res, 429, {
          error: 'Runner request rate limit exceeded',
          code: 'rate_limited'
        }, requestId);
      }
      const body = await readJsonBody(req, config.runnerControl.maxRequestBytes);
      touchCredentialBestEffort(principal.id);
      await routeRequest(req, res, url, config, principal, body, requestId);
      incrementCounter('devmate_runner_control_requests_total', {
        runner: principal.id,
        route: url.pathname,
        status: res.statusCode
      }, 1);
      observeDuration('devmate_runner_control_duration_ms', {
        route: url.pathname
      }, Date.now() - started);
      await audit('runner_control_request', {
        requestId,
        runnerId: principal.id,
        path: url.pathname,
        status: res.statusCode,
        durationMs: Date.now() - started
      });
    } catch (error) {
      const ownershipConflict = /does not own running job|not found|no longer owns|claim/i.test(String(error?.message || ''));
      const status = Number(error?.status) || (ownershipConflict ? 409 : 500);
      if (!res.headersSent) {
        json(res, status, {
          error: redactSensitiveString(error?.message || error),
          code: error?.code || (status >= 500 ? 'runner_control_error' : 'bad_request')
        }, requestId);
      } else {
        res.destroy?.(error);
      }
      incrementCounter('devmate_runner_control_errors_total', { status }, 1);
    }
  };
}

export function installRunnerControlPlane(httpModule) {
  if (httpModule[INSTALLED]) return;
  Object.defineProperty(httpModule, INSTALLED, { value: true });
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateRunnerCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === 'function') args[0] = runnerControlListener(args[0]);
    else if (typeof args[1] === 'function') args[1] = runnerControlListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}

export function resetRunnerControlState() {
  rateWindows.clear();
}

export const __test = {
  artifactPathAllowed,
  bearerToken,
  claimProof,
  consumeClaimBestEffort,
  consumeRate,
  executionEnvelope,
  hostAllowed,
  rateWindows,
  requestError,
  requestInteger,
  runnerLabels,
  runnerRegistration,
  sanitizeArtifacts,
  sanitizeResult,
  scopedSubset,
  strictBoolean,
  stringArray,
  touchCredentialBestEffort
};