import crypto from 'node:crypto';
import { readConfig, writeConfig } from './local-shared.mjs';
import { runWithRequestContext } from './request-context.mjs';
import { handlePublishedPreview, isPublishedPreviewPath } from './published-previews.mjs';
import { extractRequestToken, fallbackLocalPrincipal, normalizeDeploymentConfig, verifyAccessToken } from './team-access.mjs';

const rateWindows = new Map();
const preAuthRateWindows = new Map();
const principalInflight = new Map();
const activities = new Map();
let globalInflight = 0;
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

function remoteAddress(req) {
  return req.socket?.remoteAddress || '';
}

function hostCandidates(req) {
  const value = String(req.headers?.host || '').trim().toLowerCase();
  if (!value) return [];
  const candidates = new Set([value]);
  try {
    const parsed = new URL(`http://${value}`);
    candidates.add(parsed.hostname.toLowerCase());
  } catch {}
  return [...candidates];
}

function hostAllowed(req, config) {
  const allowed = config.production?.allowedHosts || [];
  if (!allowed.length) return true;
  const candidates = hostCandidates(req);
  if (candidates.some(item => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(item) || item.startsWith('127.0.0.1:') || item.startsWith('localhost:'))) return true;
  return allowed.some(item => candidates.includes(String(item).toLowerCase()));
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

export function authenticateGatewayRequest(req, url, config) {
  normalizeDeploymentConfig(config);
  const token = extractRequestToken(req, url);
  if (!config.team.enabled && config.auth?.required === false && !token) return fallbackLocalPrincipal();
  const principal = verifyAccessToken(token, config);
  if (!principal) return null;
  return principal;
}

function consumeRateLimit(principalId, limit, store = rateWindows) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const current = store.get(principalId);
  if (!current || current.minute !== minute) {
    store.set(principalId, { minute, count: 1 });
    return { allowed: true, remaining: Math.max(0, limit - 1), resetAt: (minute + 1) * 60000 };
  }
  if (current.count >= limit) return { allowed: false, remaining: 0, resetAt: (minute + 1) * 60000 };
  current.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - current.count), resetAt: (minute + 1) * 60000 };
}

function enterConcurrency(principalId, config) {
  const maxGlobal = config.production.maxConcurrentRequests;
  const maxPrincipal = config.production.maxConcurrentPerPrincipal;
  const currentPrincipal = principalInflight.get(principalId) || 0;
  if (globalInflight >= maxGlobal) return { allowed: false, reason: 'global', current: globalInflight, limit: maxGlobal };
  if (currentPrincipal >= maxPrincipal) return { allowed: false, reason: 'principal', current: currentPrincipal, limit: maxPrincipal };
  globalInflight += 1;
  principalInflight.set(principalId, currentPrincipal + 1);
  let released = false;
  return {
    allowed: true,
    release() {
      if (released) return;
      released = true;
      globalInflight = Math.max(0, globalInflight - 1);
      const next = Math.max(0, (principalInflight.get(principalId) || 1) - 1);
      if (next) principalInflight.set(principalId, next);
      else principalInflight.delete(principalId);
    }
  };
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

export function guardListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('HTTP listener must be a function');
  return async function devmateGuardedListener(req, res) {
    const url = requestUrl(req);
    const path = url?.pathname || requestPath(req);
    if (req.method === 'OPTIONS') return listener(req, res);
    if (isPublishedPreviewPath(path)) { handlePublishedPreview(req, res, url); return; }
    if (path !== '/mcp') return listener(req, res);

    const requestId = `req-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    let config;
    try {
      config = normalizeDeploymentConfig(readConfig());
    } catch (error) {
      jsonError(res, 500, 'DevMate configuration could not be loaded', 'config_error', requestId);
      return;
    }

    if (!hostAllowed(req, config)) {
      jsonError(res, 421, 'Request host is not allowed by the DevMate production profile', 'host_not_allowed', requestId);
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

    if (touchTeamMember(config, principal)) {
      try { writeConfig(config); } catch {}
    }
    recordActivity(req, principal, requestId);

    if (principal.source === 'team-token' && config.auth?.required !== false) {
      if (!config.auth?.token) {
        concurrency.release();
        jsonError(res, 503, 'DevMate owner token is not configured', 'owner_token_missing', requestId);
        return;
      }
      req.headers.authorization = `Bearer ${config.auth.token}`;
    }

    req.setTimeout?.(config.production.requestTimeoutMs);
    res.setHeader('x-devmate-request-id', requestId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      concurrency.release();
    };
    res.once('finish', release);
    res.once('close', release);

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
      if (!res.headersSent) jsonError(res, 500, 'DevMate request failed', 'request_failed', requestId);
      else res.destroy?.(error);
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
  principalInflight.clear();
  activities.clear();
  globalInflight = 0;
}

export const __test = {
  activities,
  consumeRateLimit,
  enterConcurrency,
  globalInflight: () => globalInflight,
  hostAllowed,
  preAuthRateWindows,
  principalInflight,
  rateWindows
};
