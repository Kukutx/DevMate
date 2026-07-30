import crypto from 'node:crypto';
import path from 'node:path';
import { audit, readConfig, redactSensitiveString, writeConfig } from './local-shared.mjs';
import { readDurableNamespace } from './durable-state.mjs';
import { preflightQueuedJob } from './job-preflight.mjs';
import {
  claimJob,
  completeJob,
  deferJob,
  failJob,
  getJob,
  heartbeatRunner,
  registerRunner,
  renewJobLease
} from './job-queue.mjs';
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

function requestUrl(req) {
  try { return new URL(req.url || '/', 'http://localhost'); }
  catch { return null; }
}

function remoteAddress(req) {
  return req.socket?.remoteAddress || '';
}

function hostAllowed(req, config) {
  const allowed = config.production?.allowedHosts || [];
  if (!allowed.length) return true;
  const raw = String(req.headers?.host || '').trim().toLowerCase();
  if (!raw) return false;
  const candidates = new Set([raw]);
  try { candidates.add(new URL(`http://${raw}`).hostname.toLowerCase()); } catch {}
  if ([...candidates].some(value =>
    ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value) ||
    value.startsWith('127.0.0.1:') || value.startsWith('localhost:')
  )) return true;
  return allowed.some(value => candidates.has(String(value || '').toLowerCase()));
}

function bearerToken(req) {
  const authorization = String(req.headers?.authorization || '');
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || '';
}

function consumeRate(id, limit) {
  const minute = Math.floor(Date.now() / 60000);
  const current = rateWindows.get(id);
  if (!current || current.minute !== minute) {
    rateWindows.set(id, { minute, count: 1 });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
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
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    const error = new Error('Runner request body must be valid JSON');
    error.status = 400;
    throw error;
  }
}

function intersect(reported, allowed, fallback = []) {
  const cleanReported = [...new Set(
    (Array.isArray(reported) ? reported : fallback)
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )];
  if (!allowed?.length) return cleanReported;
  const set = new Set(allowed);
  return cleanReported.filter(value => set.has(value));
}

function runnerRegistration(principal, body = {}) {
  const reportedCapabilities = intersect(
    body.capabilities,
    principal.capabilities,
    principal.capabilities
  ).map(value => value.toLowerCase());
  const capabilities = reportedCapabilities.length ? reportedCapabilities : ['core'];
  if (!capabilities.includes('core')) capabilities.unshift('core');

  const reportedWorkspaces = Array.isArray(body.workspaceIds)
    ? intersect(body.workspaceIds, principal.workspaceIds, [])
    : [];
  if (!reportedWorkspaces.length) {
    const error = new Error('Runner must report at least one local workspaceId allowed by its credential');
    error.status = 400;
    throw error;
  }

  return {
    id: principal.id,
    name: principal.name,
    capabilities,
    workspaceIds: reportedWorkspaces,
    maxConcurrent: Math.min(
      principal.maxConcurrent,
      Math.max(1, Math.trunc(Number(body.maxConcurrent) || principal.maxConcurrent))
    ),
    version: String(body.version || '').slice(0, 100),
    platform: String(body.platform || '').slice(0, 100),
    arch: String(body.arch || '').slice(0, 100),
    labels: body.labels && typeof body.labels === 'object' && !Array.isArray(body.labels)
      ? body.labels
      : {}
  };
}

function executionEnvelope(job) {
  try {
    const store = readDurableNamespace('jobs', { jobs: [] });
    const internal = Array.isArray(store?.jobs) ? store.jobs.find(item => item.id === job.id) : null;
    return {
      ...job,
      artifactPaths: Array.isArray(internal?.artifactPaths) ? [...internal.artifactPaths] : []
    };
  } catch {
    return { ...job, artifactPaths: [] };
  }
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
  if (!relative || relative.includes('\0') || /^[a-z]:\//i.test(relative) || relative.startsWith('//')) return false;
  const parts = relative.split('/').filter(Boolean);
  if (!parts.length || parts.some(part =>
    part === '.' || part === '..' || part.startsWith('.') || BLOCKED_ARTIFACT_SEGMENTS.has(part.toLowerCase())
  )) return false;
  return !BLOCKED_ARTIFACT_EXTENSIONS.has(path.posix.extname(parts.at(-1) || '').toLowerCase());
}

function sanitizeArtifacts(values, runnerId, workspaceId) {
  const output = [];
  const seen = new Set();
  for (const item of Array.isArray(values) ? values.slice(0, 100) : []) {
    const relative = String(item?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!artifactPathAllowed(relative) || seen.has(relative)) continue;
    seen.add(relative);
    const bytes = Math.max(
      0,
      Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(item?.bytes) || 0))
    );
    const sha256 = /^[a-f0-9]{64}$/i.test(String(item?.sha256 || ''))
      ? String(item.sha256).toLowerCase()
      : null;
    output.push({
      workspaceId: workspaceId || null,
      path: relative.slice(0, 2000),
      bytes,
      modifiedAt: Number.isFinite(Date.parse(item?.modifiedAt || ''))
        ? new Date(item.modifiedAt).toISOString()
        : null,
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

async function routeRequest(req, res, url, config, principal, body, requestId) {
  const pathName = url.pathname;
  let runner = null;

  if (pathName === `${PREFIX}/heartbeat` || pathName === `${PREFIX}/jobs/claim`) {
    runner = registerRunner(runnerRegistration(principal, body.runner || body));
  } else {
    try { heartbeatRunner(principal.id); } catch {}
  }

  if (pathName === `${PREFIX}/heartbeat`) {
    return json(res, 200, { runner, serverTime: new Date().toISOString() }, requestId);
  }

  if (pathName === `${PREFIX}/jobs/claim`) {
    const job = claimJob({ runnerId: principal.id, leaseSeconds: body.leaseSeconds });
    if (!job) return json(res, 200, { runner, job: null }, requestId);
    try {
      preflightQueuedJob(job);
      return json(res, 200, { runner, job: executionEnvelope(job) }, requestId);
    } catch (error) {
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
  catch {
    const error = new Error('Runner job identifier is not valid URL encoding');
    error.status = 400;
    throw error;
  }
  const action = match[2];

  if (action === 'renew') {
    const renewed = renewJobLease({
      id,
      runnerId: principal.id,
      leaseSeconds: body.leaseSeconds
    });
    if (!renewed) {
      return json(res, 409, {
        error: 'Runner no longer owns this running job',
        code: 'job_not_owned'
      }, requestId);
    }
    const job = getJob(id);
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
    return json(res, 200, { job }, requestId);
  }

  const job = failJob({
    id,
    runnerId: principal.id,
    error: redactSensitiveString(String(
      body.error || (action === 'cancelled'
        ? 'Runner cancelled execution'
        : 'Runner execution failed')
    )).slice(0, 4000),
    retryable: action === 'fail' && body.retryable !== false
  });
  return json(res, 200, { job }, requestId);
}

export function runnerControlListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('HTTP listener must be a function');
  return async function devmateRunnerControl(req, res) {
    const url = requestUrl(req);
    if (!url?.pathname.startsWith(PREFIX)) return listener(req, res);
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
      const latestConfig = normalizeRunnerControlConfig(readConfig());
      if (touchRunnerCredential(latestConfig, principal.id)) writeConfig(latestConfig);
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
      const ownershipConflict = /does not own running job|not found|no longer owns/i.test(String(error?.message || ''));
      const status = Number(error?.status) || (ownershipConflict ? 409 : 500);
      if (!res.headersSent) {
        json(res, status, {
          error: redactSensitiveString(error?.message || error),
          code: status >= 500 ? 'runner_control_error' : 'bad_request'
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
  executionEnvelope,
  hostAllowed,
  intersect,
  runnerRegistration,
  sanitizeArtifacts,
  sanitizeResult
};
