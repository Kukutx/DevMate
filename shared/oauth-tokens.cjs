'use strict';

const crypto = require('node:crypto');

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseBase64urlJson(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value || ''), 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function signature(key, payload) {
  return crypto.createHmac('sha256', String(key || '')).update(payload, 'utf8').digest('base64url');
}

function equal(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seal(prefix, payload, key) {
  const encoded = base64urlJson(payload);
  return `${prefix}.${encoded}.${signature(key, `${prefix}.${encoded}`)}`;
}

function unseal(value, prefix, key) {
  const parts = String(value || '').split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const signed = `${parts[0]}.${parts[1]}`;
  if (!equal(parts[2], signature(key, signed))) return null;
  return parseBase64urlJson(parts[1]);
}

function oauthKey(config) {
  return String(config?.auth?.mode === 'oauth' ? config.auth.oauth?.signingKey || '' : '');
}

function issueAccessToken(config, { audience, scope = 'devmate offline_access', subject = 'owner', ttlSeconds = 3600 } = {}) {
  const key = oauthKey(config);
  const aud = String(audience || '').replace(/\/$/, '');
  if (!key || !aud) throw new Error('OAuth authentication is not configured');
  const now = Math.floor(Date.now() / 1000);
  return seal('dmoa', {
    aud,
    exp: now + Math.max(60, Math.min(3600, Number(ttlSeconds) || 3600)),
    iat: now,
    jti: crypto.randomBytes(12).toString('base64url'),
    scope: String(scope || 'devmate').trim(),
    sub: String(subject || 'owner').trim() || 'owner'
  }, key);
}

function preflightAccessToken(config, publicUrl) {
  if (config?.auth?.mode !== 'oauth') return '';
  const endpoint = new URL('/mcp', `${String(publicUrl || '').replace(/\/$/, '')}/`);
  endpoint.search = '';
  endpoint.hash = '';
  return issueAccessToken(config, {
    audience: endpoint.toString(),
    subject: 'desktop-preflight',
    ttlSeconds: 600
  });
}

function verifyAccessToken(config, token, audience) {
  const key = oauthKey(config);
  const expectedAudience = String(audience || '').replace(/\/$/, '');
  if (!key || !expectedAudience) return null;
  const payload = unseal(token, 'dmoa', key);
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.aud !== expectedAudience || !Number.isInteger(payload.exp) || payload.exp <= now || !payload.sub) return null;
  return payload;
}

function issueRefreshToken(config, { audience, scope = 'devmate offline_access', subject = 'owner', ttlSeconds = 30 * 24 * 60 * 60 } = {}) {
  const key = oauthKey(config);
  const aud = String(audience || '').replace(/\/$/, '');
  if (!key || !aud) throw new Error('OAuth authentication is not configured');
  const now = Math.floor(Date.now() / 1000);
  return seal('dmor', {
    aud,
    exp: now + Math.max(3600, Math.min(90 * 24 * 60 * 60, Number(ttlSeconds) || 30 * 24 * 60 * 60)),
    iat: now,
    jti: crypto.randomBytes(12).toString('base64url'),
    scope: String(scope || 'devmate').trim(),
    sub: String(subject || 'owner').trim() || 'owner'
  }, key);
}

function verifyRefreshToken(config, token, audience) {
  const key = oauthKey(config);
  const expectedAudience = String(audience || '').replace(/\/$/, '');
  if (!key || !expectedAudience) return null;
  const payload = unseal(token, 'dmor', key);
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.aud !== expectedAudience || !Number.isInteger(payload.exp) || payload.exp <= now || !payload.sub) return null;
  return payload;
}

module.exports = {
  equal,
  issueAccessToken,
  issueRefreshToken,
  preflightAccessToken,
  seal,
  unseal,
  verifyAccessToken,
  verifyRefreshToken
};
