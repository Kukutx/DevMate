'use strict';

const crypto = require('node:crypto');
const { readOAuthSecrets } = require('./oauth-secrets.cjs');

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
  const secret = String(key || '');
  if (secret.length < 43) throw new Error('OAuth signing key is unavailable');
  const encoded = base64urlJson(payload);
  return `${prefix}.${encoded}.${signature(secret, `${prefix}.${encoded}`)}`;
}

function unseal(value, prefix, key) {
  const secret = String(key || '');
  if (secret.length < 43) return null;
  const parts = String(value || '').split('.');
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const signed = `${parts[0]}.${parts[1]}`;
  if (!equal(parts[2], signature(secret, signed))) return null;
  return parseBase64urlJson(parts[1]);
}

function normalizedAudience(audience) {
  return String(audience || '').replace(/\/$/, '');
}

function normalizedSubject(subject) {
  const value = String(subject || '').trim();
  if (!value) throw new Error('OAuth token subject is required');
  return value;
}

function normalizedScope(scope) {
  const values = [...new Set(String(scope || 'devmate').split(/\s+/).filter(Boolean))];
  if (!values.includes('devmate')) throw new Error('OAuth token must include the devmate scope');
  if (values.some(value => !['devmate', 'offline_access'].includes(value))) throw new Error('OAuth token scope is unsupported');
  return values.join(' ');
}

function issueAccessToken(signingKey, {
  audience,
  scope = 'devmate',
  subject,
  authVersion = null,
  ttlSeconds = 3600
} = {}) {
  const aud = normalizedAudience(audience);
  if (!aud) throw new Error('OAuth token audience is required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud,
    exp: now + Math.max(60, Math.min(3600, Number(ttlSeconds) || 3600)),
    iat: now,
    jti: crypto.randomBytes(16).toString('base64url'),
    scope: normalizedScope(scope),
    sub: normalizedSubject(subject)
  };
  if (authVersion != null) {
    const version = Number(authVersion);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('OAuth auth version is invalid');
    payload.av = version;
  }
  return seal('dmoa', payload, signingKey);
}

function verifyAccessToken(signingKey, token, audience) {
  const expectedAudience = normalizedAudience(audience);
  if (!expectedAudience) return null;
  const payload = unseal(token, 'dmoa', signingKey);
  const now = Math.floor(Date.now() / 1000);
  if (
    !payload || payload.aud !== expectedAudience || !Number.isInteger(payload.exp) || payload.exp <= now ||
    !Number.isInteger(payload.iat) || payload.iat > now + 60 || typeof payload.jti !== 'string' || !payload.jti ||
    typeof payload.sub !== 'string' || !payload.sub || typeof payload.scope !== 'string'
  ) return null;
  try { normalizedScope(payload.scope); } catch { return null; }
  return payload;
}

function issueRefreshToken(signingKey, {
  audience,
  scope = 'devmate offline_access',
  subject,
  authVersion = null,
  familyId,
  generation,
  ttlSeconds = 30 * 24 * 60 * 60
} = {}) {
  const aud = normalizedAudience(audience);
  if (!aud) throw new Error('OAuth refresh-token audience is required');
  const fid = String(familyId || '').trim();
  const gen = Number(generation);
  if (!fid || !Number.isSafeInteger(gen) || gen < 1) throw new Error('OAuth refresh-token family state is required');
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud,
    exp: now + Math.max(3600, Math.min(90 * 24 * 60 * 60, Number(ttlSeconds) || 30 * 24 * 60 * 60)),
    fid,
    gen,
    iat: now,
    jti: crypto.randomBytes(16).toString('base64url'),
    scope: normalizedScope(scope),
    sub: normalizedSubject(subject)
  };
  if (authVersion != null) {
    const version = Number(authVersion);
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('OAuth auth version is invalid');
    payload.av = version;
  }
  return seal('dmor', payload, signingKey);
}

function verifyRefreshToken(signingKey, token, audience) {
  const expectedAudience = normalizedAudience(audience);
  if (!expectedAudience) return null;
  const payload = unseal(token, 'dmor', signingKey);
  const now = Math.floor(Date.now() / 1000);
  if (
    !payload || payload.aud !== expectedAudience || !Number.isInteger(payload.exp) || payload.exp <= now ||
    !Number.isInteger(payload.iat) || payload.iat > now + 60 || typeof payload.jti !== 'string' || !payload.jti ||
    typeof payload.fid !== 'string' || !payload.fid || !Number.isSafeInteger(payload.gen) || payload.gen < 1 ||
    typeof payload.sub !== 'string' || !payload.sub || typeof payload.scope !== 'string'
  ) return null;
  try { normalizedScope(payload.scope); } catch { return null; }
  return payload;
}

function preflightAccessToken(config, publicUrl, configFile) {
  if (config?.auth?.mode !== 'oauth') return '';
  const endpoint = new URL('/mcp', `${String(publicUrl || '').replace(/\/$/, '')}/`);
  endpoint.search = '';
  endpoint.hash = '';
  const secrets = readOAuthSecrets(configFile);
  return issueAccessToken(secrets.signingKey, {
    audience: endpoint.toString(),
    scope: 'devmate',
    subject: 'owner',
    ttlSeconds: 600
  });
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
