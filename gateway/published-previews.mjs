import crypto from 'node:crypto';
import http from 'node:http';
import { getPreview } from './plugins/preview-manager.mjs';
import { isLoopbackHostname } from './http-host-policy.mjs';
import { defaultedInteger } from './strict-config.mjs';

export const MAX_PREVIEW_SHARES = 1000;
export const MAX_PREVIEW_SESSIONS = 10000;
export const MAX_SESSIONS_PER_SHARE = 100;
export const PREVIEW_PROXY_TIMEOUT_MS = 30000;

const shares = new Map();
const sessions = new Map();
const PREFIX = '/devmate/previews/';

function capacityError(message) {
  const error = new Error(message);
  error.code = 'preview_capacity';
  error.status = 503;
  return error;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('base64url');
}

function normalizeShareOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A stable deployment publicUrl is required to publish previews');
  const url = new URL(value.trim());
  const local = isLoopbackHostname(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Published preview publicUrl must use HTTPS; HTTP is allowed only for loopback');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')) {
    throw new Error('Published preview publicUrl must be a clean origin without credentials, path, query, or fragment');
  }
  return `${url.protocol}//${url.host}`;
}

function parseCookies(req) {
  const output = {};
  for (const item of String(req.headers?.cookie || '').slice(0, 32768).split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    const key = item.slice(0, index).trim().slice(0, 200);
    const raw = item.slice(index + 1).trim().slice(0, 4096);
    if (!key) continue;
    try { output[key] = decodeURIComponent(raw); }
    catch { output[key] = ''; }
  }
  return output;
}

function sessionsForShare(shareId) {
  let count = 0;
  for (const session of sessions.values()) if (session.shareId === shareId) count += 1;
  return count;
}

function pruneShares() {
  const timestamp = Date.now();
  const activeShareIds = new Set();
  for (const [hash, share] of shares) {
    if (Date.parse(share.expiresAt) <= timestamp || share.revoked) shares.delete(hash);
    else activeShareIds.add(share.id);
  }
  for (const [hash, session] of sessions) {
    if (Date.parse(session.expiresAt) <= timestamp || !activeShareIds.has(session.shareId)) sessions.delete(hash);
  }
}

export function createPreviewShare({ previewId, principal, publicUrl, ttlSeconds = 3600, maxUses = 0 }) {
  pruneShares();
  if (shares.size >= MAX_PREVIEW_SHARES) {
    throw capacityError(`Published preview share limit reached (${MAX_PREVIEW_SHARES})`);
  }
  const origin = normalizeShareOrigin(publicUrl);
  const preview = getPreview(previewId);
  const ttl = defaultedInteger(ttlSeconds, 3600, 60, 86400, 'published preview ttlSeconds');
  const allowedUses = defaultedInteger(maxUses, 0, 0, 100000, 'published preview maxUses');
  const secret = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomBytes(6).toString('hex');
  const token = `dmps_${id}_${secret}`;
  const share = {
    id,
    previewId,
    workspaceId: preview.workspaceId,
    createdBy: principal?.id || 'unknown',
    createdByName: principal?.name || principal?.id || 'unknown',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    maxUses: allowedUses,
    uses: 0,
    revoked: false
  };
  shares.set(tokenHash(token), share);
  const url = new URL(`${origin}${PREFIX}${encodeURIComponent(previewId)}/`);
  url.searchParams.set('share', token);
  return { share: { ...share, activeSessions: 0 }, url: url.toString(), token };
}

export function listPreviewShares({ workspaceId, previewId } = {}) {
  pruneShares();
  return [...shares.values()]
    .filter(share => (!workspaceId || share.workspaceId === workspaceId) && (!previewId || share.previewId === previewId))
    .map(share => ({ ...share, activeSessions: sessionsForShare(share.id) }));
}

export function revokePreviewShare(id) {
  pruneShares();
  for (const [hash, share] of shares) {
    if (share.id !== id) continue;
    shares.delete(hash);
    for (const [sessionHash, session] of sessions) {
      if (session.shareId === id) sessions.delete(sessionHash);
    }
    return { revoked: true, share: { ...share, revoked: true } };
  }
  return { revoked: false, id, reason: 'not found or expired' };
}

function verifyShare(token, previewId) {
  pruneShares();
  const share = shares.get(tokenHash(token));
  if (!share || share.previewId !== previewId) return null;
  if (Date.parse(share.expiresAt) <= Date.now()) return null;
  if (share.maxUses && share.uses >= share.maxUses) return null;
  return share;
}

function createBrowserSession(share) {
  pruneShares();
  if (sessions.size >= MAX_PREVIEW_SESSIONS) {
    throw capacityError(`Published preview browser-session limit reached (${MAX_PREVIEW_SESSIONS})`);
  }
  if (sessionsForShare(share.id) >= MAX_SESSIONS_PER_SHARE) {
    throw capacityError(`Published preview session limit reached for share ${share.id} (${MAX_SESSIONS_PER_SHARE})`);
  }
  const secret = crypto.randomBytes(32).toString('base64url');
  const token = `dmpr_${share.id}_${secret}`;
  const session = {
    id: crypto.randomBytes(6).toString('hex'),
    shareId: share.id,
    previewId: share.previewId,
    createdAt: new Date().toISOString(),
    expiresAt: share.expiresAt
  };
  sessions.set(tokenHash(token), session);
  share.uses += 1;
  return { token, session };
}

function verifyBrowserSession(token, previewId) {
  pruneShares();
  const session = sessions.get(tokenHash(token));
  if (!session || session.previewId !== previewId || Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}

function writeError(res, status, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(message);
}

function safeProxyHeaders(headers) {
  const output = {};
  for (const key of ['range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding', 'user-agent']) {
    if (headers?.[key] !== undefined) output[key] = String(headers[key]).slice(0, 8192);
  }
  return output;
}

function copyResponseHeaders(upstream, res) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'transfer-encoding', 'upgrade']);
  for (const [key, value] of Object.entries(upstream.headers || {})) {
    if (blocked.has(key.toLowerCase()) || value === undefined) continue;
    try { res.setHeader(key, value); } catch {}
  }
  res.setHeader('cache-control', upstream.headers?.['cache-control'] || 'no-cache');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
}

function proxyPreview(req, res, preview, relativePath) {
  const targetPath = relativePath && relativePath !== '/' ? relativePath : `/${preview.entryPath}`;
  const options = {
    hostname: preview.host,
    port: preview.port,
    path: targetPath,
    method: req.method,
    headers: safeProxyHeaders(req.headers)
  };
  let settled = false;
  const upstream = http.request(options, upstreamResponse => {
    if (settled) { upstreamResponse.destroy(); return; }
    copyResponseHeaders(upstreamResponse, res);
    res.writeHead(upstreamResponse.statusCode || 502);
    upstreamResponse.pipe(res);
  });
  const fail = message => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) writeError(res, 502, message);
    else res.destroy();
  };
  upstream.setTimeout(PREVIEW_PROXY_TIMEOUT_MS, () => upstream.destroy(new Error('Preview proxy timed out')));
  upstream.on('error', error => fail(`Preview proxy failed: ${error.message}`));
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { settled = true; upstream.destroy(); });
  upstream.end();
}

function forwardedHttps(req) {
  if (req.socket?.encrypted) return true;
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  return /(?:^|;)\s*proto=https(?:;|$)/i.test(String(req.headers?.forwarded || ''));
}

export function isPublishedPreviewPath(pathname) {
  return String(pathname || '').startsWith(PREFIX);
}

export function handlePublishedPreview(req, res, url) {
  if (!isPublishedPreviewPath(url.pathname)) return false;
  const method = String(req.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method)) {
    writeError(res, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
    return true;
  }
  const remainder = url.pathname.slice(PREFIX.length);
  const slash = remainder.indexOf('/');
  const encodedId = slash < 0 ? remainder : remainder.slice(0, slash);
  let previewId;
  try { previewId = decodeURIComponent(encodedId || ''); }
  catch { writeError(res, 400, 'Preview identifier is not valid URL encoding'); return true; }
  const relativePath = slash < 0 ? '/' : remainder.slice(slash) || '/';
  let preview;
  try { preview = getPreview(previewId); }
  catch { writeError(res, 404, 'Preview not found'); return true; }

  const queryToken = url.searchParams.get('share') || '';
  if (queryToken) {
    const share = verifyShare(queryToken, previewId);
    if (!share) { writeError(res, 401, 'Preview share token is invalid, expired, or exhausted'); return true; }
    let browserSession;
    try { browserSession = createBrowserSession(share); }
    catch (error) { writeError(res, error.status || 503, error.message); return true; }
    const cookiePath = `${PREFIX}${encodeURIComponent(previewId)}/`;
    res.setHeader(
      'set-cookie',
      `devmate_preview_session=${encodeURIComponent(browserSession.token)}; Path=${cookiePath}; HttpOnly; SameSite=Strict${forwardedHttps(req) ? '; Secure' : ''}`
    );
    const redirect = new URL(url.toString());
    redirect.searchParams.delete('share');
    res.writeHead(302, {
      location: `${redirect.pathname}${redirect.search}`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer'
    });
    res.end();
    return true;
  }

  const sessionToken = parseCookies(req).devmate_preview_session || '';
  if (!verifyBrowserSession(sessionToken, previewId)) {
    writeError(res, 401, 'Preview browser session is invalid or expired');
    return true;
  }
  proxyPreview(req, res, preview, relativePath);
  return true;
}

export function previewShareCapacityStatus() {
  pruneShares();
  return {
    shares: shares.size,
    sessions: sessions.size,
    limits: {
      maxShares: MAX_PREVIEW_SHARES,
      maxSessions: MAX_PREVIEW_SESSIONS,
      maxSessionsPerShare: MAX_SESSIONS_PER_SHARE
    }
  };
}

export function clearPreviewShares() {
  shares.clear();
  sessions.clear();
}

export const __test = {
  PREFIX,
  capacityError,
  createBrowserSession,
  normalizeShareOrigin,
  parseCookies,
  pruneShares,
  sessions,
  sessionsForShare,
  shares,
  tokenHash,
  verifyBrowserSession,
  verifyShare
};
