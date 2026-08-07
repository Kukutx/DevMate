import crypto from 'node:crypto';
import { mutateConfig, readConfig } from './local-shared.mjs';
import { consumeFixedWindow } from './fixed-window-rate-limit.mjs';
import { hostAllowed, isLocalRequest, loopbackHost, loopbackSocket, remoteAddress } from './http-host-policy.mjs';
import { sharedHttpRequestConcurrency } from './request-concurrency.mjs';
import { runWithRequestContext } from './request-context.mjs';
import { handlePublishedPreview, isPublishedPreviewPath } from './published-previews.mjs';
import { extractRequestToken, fallbackLocalPrincipal, normalizeDeploymentConfig, verifyAccessToken } from './team-access.mjs';

const rateWindows = new Map();
const preAuthRateWindows = new Map();
const requestConcurrency = sharedHttpRequestConcurrency;
const activities = new Map();
let installed = false;

function nowIso() { return new Date().toISOString(); }

function requestPath(req) {
  try { return new URL(req.url || '/', 'http://localhost').pathname; }
  catch { return ''; }
}

function requestUrl(req) {
  try { return new URL(req.url || '/', 'http://localhost'); }
  catch { return null; }
}

function jsonError(res, status, message, code, requestId, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'x-devmate-request-id': requestId });
  res.end(JSON.stringify({ error: message, code, requestId, ...extra }));
}

function touchTeamMember(config, principal) {
  if (principal?.source !== 'team-token') return false;
  const member = config.team?.members?.find(item => item.id === principal.id);
  if (!member) return false;
  const last = Date.parse(member.lastUsedAt || 0);
  if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000) return false;
  member.lastUsedAt = nowIso();
  return true;
}

function touchTeamMemberBestEffort(principal) {
  if (principal?.source !== 'team-token') return false;
  try {
    const preview = normalizeDeploymentConfig(readConfig());
    if (!touchTeamMember(preview, principal)) return false;
    mutateConfig(config => {
      normalizeDeploymentConfig(config);
      touchTeamMember(config, principal);
      return config;
    }, { retries: 4 });
    return true;
  } catch {
    return false;
  }
}

export function authenticateGatewayRequest(req, url, config) {
  normalizeDeploymentConfig(config);
  const token = extractRequestToken(req, url);
  if (!config.team.enabled && config.auth?.required === false && !token) {
    return isLocalRequest(req) ? fallbackLocalPrincipal() : null;
  }
  const principal = verifyAccessToken(token, config);
  if (!principal) return null;
  return principal;
}

function normalizeInnerAuthorization(req, config) {
  if (req.headers) delete req.headers['x-devmate-token'];
  if (config.auth?.required === false) {
    if (req.headers) delete req.headers.authorization;
    return true;
  }
  if (!config.auth?.token) return false;
  req.headers.authorization = `Bearer ${config.auth.token}`;
  return true;
}

function consumeRateLimit(principalId, limit, store = rateWindows) {
  return consumeFixedWindow(store, principalId, limit, { maxEntries: 10_000 });
}

function consumePreviewRateLimit(req, config) {
  const key = `preview-ip:${remoteAddress(req) || 'unknown'}`;
  const limit = Math.max(240, config.production.requestsPerMinute * 4);
  return consumeRateLimit(key, limit, preAuthRateWindows);
}

function enterConcurrency(principalId, config) {
  return requestConcurrency.enter(
    `mcp:${principalId}`,
    config.production.maxConcurrentRequests,
    config.production.maxConcurrentPerPrincipal
  );
}

function activityKey(req, principal) {
  const session = String(req.headers?.['mcp-session-id'] || '').trim();
  if (session) return `session:${session}`;
  const agent = String(req.headers?.['user-agent'] || '').slice(0, 200);
  return `principal:${principal.id}:${crypto.createHash('sha256').update(agent).digest('hex').slice(0, 12)}`;
}

function recordActivity(req, principal, requestId) {
  const key = activityKey(req, principal);
  const existing = activities.get(key) || {
    key,
    principalId: principal.id,
    principalName: principal.name,
    role: principal.role,
    source: principal.source,
    firstSeenAt: nowIso(),
    requests: 0
  };
  existing.lastSeenAt = nowIso();
  existing.requests += 1;
  existing.lastRequestId = requestId;
  existing.remoteAddress = remoteAddress(req);
  existing.userAgent = String(req.headers?.['user-agent'] || '').slice(0, 300);
  existing.sessionId = String(req.headers?.['mcp-session-id'] || '') || null;
  activities.set(key, existing);
  if (activities.size > 1000) {
    const oldest = [...activities.values()].sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt))).slice(0, activities.size - 1000);
    for (const item of oldest) activities.delete(item.key);
  }
}

export function activitySnapshot({ activeWithinMinutes = 60 } = {}) {
  const cutoff = Date.now() - Math.max(1, Number(activeWithinMinutes) || 60) * 60 * 1000;
  return [...activities.values()]
    .filter(item => Date.parse(item.lastSeenAt || 0) >= cutoff)
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .map(item => ({ ...item }));
}

function installRequestBodyLimit(req, res, maxBytes, requestId) {
  const state = { bytes: 0, overflowed: false };
  if (req.method !== 'POST' || typeof req.push !== 'function') return state;
  const originalPush = req.push;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    if (req.push === limitedPush) req.push = originalPush;
    req.off?.('close', restore);
  };
  function limitedPush(chunk, encoding) {
    if (chunk != null && !state.overflowed) {
      state.bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
      if (state.bytes > maxBytes) {
        state.overflowed = true;
        jsonError(res, 413, 'MCP request body exceeds the configured limit', 'request_too_large', requestId, { maxRequestBytes: maxBytes });
        const error = new Error(`MCP request body exceeds ${maxBytes} bytes`);
        error.code = 'request_too_large';
        queueMicrotask(() => req.destroy?.(error));
        return false;
      }
    }
    const result = originalPush.call(this, chunk, encoding);
    if (chunk == null) restore();
    return result;
  }
  req.push = limitedPush;
  req.once?.('close', restore);
  return state;
}

export function guardListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('HTTP listener must be a function');
  return async function devmateGuardedListener(req, res) {
    const url = requestUrl(req);
    const pathName = url?.pathname || requestPath(req);
    if (req.method === 'OPTIONS') return listener(req, res);
    const publishedPreview = isPublishedPreviewPath(pathName);
    if (!publishedPreview && pathName !== '/mcp') return listener(req, res);

    const requestId = `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    let config;
    try {
      config = normalizeDeploymentConfig(readConfig());
    } catch {
      jsonError(res, 500, 'DevMate configuration could not be loaded', 'config_error', requestId);
      return;
    }

    if (!hostAllowed(req, config)) {
      jsonError(res, 421, 'Request host is not allowed by the DevMate production profile', 'host_not_allowed', requestId);
      return;
    }
    res.setHeader('x-devmate-request-id', requestId);

    if (publishedPreview) {
      const previewRate = consumePreviewRateLimit(req, config);
      res.setHeader('x-devmate-rate-limit-remaining', String(previewRate.remaining));
      res.setHeader('x-devmate-rate-limit-reset', new Date(previewRate.resetAt).toISOString());
      if (!previewRate.allowed) {
        jsonError(res, 429, 'Published preview request rate limit exceeded', 'preview_rate_limited', requestId, {
          resetAt: new Date(previewRate.resetAt).toISOString()
        });
        return;
      }
      handlePublishedPreview(req, res, url);
      return;
    }

    const contentLength = Number(req.headers?.['content-length'] || 0);
    if (Number.isFinite(contentLength) && contentLength > config.production.maxRequestBytes) {
      jsonError(res, 413, 'MCP request body exceeds the configured limit', 'request_too_large', requestId, { maxRequestBytes: config.production.maxRequestBytes });
      return;
    }

    const preAuthKey = `ip:${remoteAddress(req) || 'unknown'}`;
    const preAuthLimit = Math.max(120, config.production.requestsPerMinute * 4);
    const preAuthRate = consumeRateLimit(preAuthKey, preAuthLimit, preAuthRateWindows);
    if (!preAuthRate.allowed) {
      jsonError(res, 429, 'DevMate authentication request rate limit exceeded', 'preauth_rate_limited', requestId, { resetAt: new Date(preAuthRate.resetAt).toISOString() });
      return;
    }

    const principal = authenticateGatewayRequest(req, url, config);
    if (!principal) {
      jsonError(res, 401, 'Unauthorized DevMate request', 'unauthorized', requestId);
      return;
    }

    const rate = consumeRateLimit(principal.id, config.production.requestsPerMinute);
    res.setHeader('x-devmate-rate-limit-remaining', String(rate.remaining));
    res.setHeader('x-devmate-rate-limit-reset', new Date(rate.resetAt).toISOString());
    if (!rate.allowed) {
      jsonError(res, 429, 'DevMate request rate limit exceeded', 'rate_limited', requestId, { resetAt: new Date(rate.resetAt).toISOString() });
      return;
    }

    const concurrency = enterConcurrency(principal.id, config);
    if (!concurrency.allowed) {
      jsonError(res, 429, 'DevMate concurrent request limit exceeded', 'concurrency_limited', requestId, { scope: concurrency.reason, limit: concurrency.limit });
      return;
    }

    touchTeamMemberBestEffort(principal);
    recordActivity(req, principal, requestId);

    if (!normalizeInnerAuthorization(req, config)) {
      concurrency.release();
      jsonError(res, 503, 'DevMate owner token is not configured', 'owner_token_missing', requestId);
      return;
    }

    req.setTimeout?.(config.production.requestTimeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      concurrency.release();
    };
    res.once('finish', release);
    res.once('close', release);

    const bodyLimit = installRequestBodyLimit(req, res, config.production.maxRequestBytes, requestId);
    const context = {
      requestId,
      principal,
      startedAt: nowIso(),
      remoteAddress: remoteAddress(req),
      userAgent: String(req.headers?.['user-agent'] || '').slice(0, 300),
      deploymentMode: config.deployment.mode
    };
    try {
      await runWithRequestContext(context, () => listener(req, res));
    } catch (error) {
      release();
      if (bodyLimit.overflowed) {
        if (!res.headersSent) jsonError(res, 413, 'MCP request body exceeds the configured limit', 'request_too_large', requestId, { maxRequestBytes: config.production.maxRequestBytes });
      } else if (!res.headersSent) {
        jsonError(res, 500, 'DevMate request failed', 'request_failed', requestId);
      } else {
        res.destroy?.(error);
      }
    }
  };
}

export function installGatewayRequestGuard(httpModule) {
  if (installed) return;
  installed = true;
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === 'function') args[0] = guardListener(args[0]);
    else if (typeof args[1] === 'function') args[1] = guardListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}

export function resetRequestGuardState() {
  rateWindows.clear();
  preAuthRateWindows.clear();
  requestConcurrency.reset();
  activities.clear();
}

export const __test = {
  activities,
  consumePreviewRateLimit,
  consumeRateLimit,
  enterConcurrency,
  globalInflight: requestConcurrency.global,
  hostAllowed,
  installRequestBodyLimit,
  isLocalRequest,
  loopbackHost,
  loopbackSocket,
  normalizeInnerAuthorization,
  preAuthRateWindows,
  principalInflight: requestConcurrency.principals,
  rateWindows,
  touchTeamMemberBestEffort
};
