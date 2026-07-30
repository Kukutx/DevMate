import crypto from 'node:crypto';
import http from 'node:http';
import { getPreview } from './plugins/preview-manager.mjs';

const shares = new Map();
const sessions = new Map();
const PREFIX = '/devmate/previews/';

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('base64url');
}

function parseCookies(req) {
  const output = {};
  for (const item of String(req.headers?.cookie || '').split(';')) {
    const index = item.indexOf('=');
    if (index < 1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) output[key] = decodeURIComponent(value);
  }
  return output;
}

function pruneShares() {
  const now = Date.now();
  for (const [hash, share] of shares) {
    if (Date.parse(share.expiresAt) <= now) shares.delete(hash);
  }
  for (const [hash, session] of sessions) {
    if (Date.parse(session.expiresAt) <= now || ![...shares.values()].some(share => share.id === session.shareId)) {
      sessions.delete(hash);
    }
  }
}

export function createPreviewShare({ previewId, principal, publicUrl, ttlSeconds = 3600, maxUses = 0 }) {
  const preview = getPreview(previewId);
  const origin = String(publicUrl || '').replace(/\/$/, '');
  if (!origin) throw new Error('A stable deployment publicUrl is required to publish previews');
  const ttl = Math.min(86400, Math.max(60, Math.trunc(Number(ttlSeconds) || 3600)));
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
    maxUses: Math.min(100000, Math.max(0, Math.trunc(Number(maxUses) || 0))),
    uses: 0,
    activeSessions: 0,
    revoked: false
  };
  shares.set(tokenHash(token), share);
  const url = new URL(`${origin}${PREFIX}${encodeURIComponent(previewId)}/`);
  url.searchParams.set('share', token);
  return { share: { ...share }, url: url.toString(), token };
}

export function listPreviewShares({ workspaceId, previewId } = {}) {
  pruneShares();
  return [...shares.values()]
    .filter(share => (!workspaceId || share.workspaceId === workspaceId) && (!previewId || share.previewId === previewId))
    .map(share => ({
      ...share,
      activeSessions: [...sessions.values()].filter(session => session.shareId === share.id).length
    }));
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

function writeError(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(message);
}

function safeProxyHeaders(headers) {
  const output = {};
  for (const key of ['range', 'if-none-match', 'if-modified-since', 'accept', 'accept-encoding', 'user-agent']) {
    if (headers?.[key] !== undefined) output[key] = headers[key];
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
  const upstream = http.request(options, upstreamResponse => {
    copyResponseHeaders(upstreamResponse, res);
    res.writeHead(upstreamResponse.statusCode || 502);
    upstreamResponse.pipe(res);
  });
  upstream.on('error', error => writeError(res, 502, `Preview proxy failed: ${error.message}`));
  req.on('aborted', () => upstream.destroy());
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
  const remainder = url.pathname.slice(PREFIX.length);
  const slash = remainder.indexOf('/');
  const encodedId = slash < 0 ? remainder : remainder.slice(0, slash);
  const previewId = decodeURIComponent(encodedId || '');
  const relativePath = slash < 0 ? '/' : remainder.slice(slash) || '/';
  let preview;
  try { preview = getPreview(previewId); }
  catch { writeError(res, 404, 'Preview not found'); return true; }

  const queryToken = url.searchParams.get('share') || '';
  if (queryToken) {
    const share = verifyShare(queryToken, previewId);
    if (!share) { writeError(res, 401, 'Preview share token is invalid, expired, or exhausted'); return true; }
    const browserSession = createBrowserSession(share);
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

export function clearPreviewShares() {
  shares.clear();
  sessions.clear();
}

export const __test = {
  PREFIX,
  createBrowserSession,
  parseCookies,
  sessions,
  shares,
  tokenHash,
  verifyBrowserSession,
  verifyShare
};
