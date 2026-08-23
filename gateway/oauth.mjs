import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import tokens from '../shared/oauth-tokens.cjs';
import oauthSecrets from '../shared/oauth-secrets.cjs';
import { CONFIG_PATH, mutateConfig, readConfig } from './local-shared.mjs';
import { hostAllowed, isLoopbackHostname } from './http-host-policy.mjs';
import { normalizeInstanceConfig, principalFromOAuthClaims, verifyMemberLoginCode } from './team-access.mjs';
import {
  consumeAuthorizationCode,
  consumeRefreshFamily,
  createRefreshFamily,
  registerAuthorizationCode,
  revokeRefreshFamily
} from './oauth-state.mjs';

const { equal, issueAccessToken, issueRefreshToken, seal, unseal, verifyAccessToken, verifyRefreshToken } = tokens;
const { readOAuthSecrets, rotateOwnerApprovalCode } = oauthSecrets;
const CODE_TTL_SECONDS = 5 * 60;
const CIMD_CACHE_TTL_MS = 5 * 60 * 1000;
const CIMD_FETCH_TIMEOUT_MS = 5000;
const MAX_OAUTH_REQUEST_BYTES = 64 * 1024;
const MAX_CIMD_BYTES = 64 * 1024;
const MAX_CIMD_CACHE = 500;
const OAUTH_REQUEST_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke'
]);
const cimdCache = new Map();

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function html(res, status, value) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  });
  res.end(value);
}

function escape(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function formPage(parameters, client, error = '') {
  const fields = [...parameters.entries()]
    .filter(([key]) => key !== 'authorization_code')
    .map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`)
    .join('');
  const clientName = escape(client?.client_name || 'MCP client');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize DevMate</title><style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:10vh auto;padding:0 1.25rem;color:#18212b}input,button{font:inherit;padding:.7rem;width:100%;box-sizing:border-box}button{margin-top:1rem;background:#0b75b7;color:#fff;border:0;border-radius:.35rem}.error{color:#b42318}.muted{color:#5d6874}</style></head><body><h1>Authorize DevMate</h1><p><strong>${clientName}</strong> is requesting access to this DevMate instance.</p><p class="muted">Use the one-time owner approval code or an OAuth member login code created by DevMate.</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<form method="post">${fields}<label>Authorization code<input required autofocus autocomplete="one-time-code" name="authorization_code" type="password"></label><button type="submit">Authorize</button></form></body></html>`;
}

function originFor(req) {
  const host = String(req.headers.host || '').split(',')[0].trim();
  if (!host || /[\s/\\@]/.test(host)) throw new Error('OAuth request has an invalid host');
  let hostname;
  try { hostname = new URL(`http://${host}`).hostname; }
  catch { throw new Error('OAuth request has an invalid host'); }
  const protocol = isLoopbackHostname(hostname) ? 'http' : 'https';
  return `${protocol}://${host}`;
}

function mcpAudience(req) {
  return `${originFor(req)}/mcp`;
}

function oauthRequestPath(url) {
  return OAUTH_REQUEST_PATHS.has(String(url?.pathname || ''));
}

function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['devmate', 'offline_access'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true
  };
}

function protectedResourceMetadata(req) {
  return {
    resource: mcpAudience(req),
    authorization_servers: [originFor(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['devmate']
  };
}

function sha256base64url(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
}

function isRedirectUriAllowed(value) {
  try {
    const url = new URL(String(value || ''));
    const localhost = isLoopbackHostname(url.hostname);
    if (url.username || url.password || url.hash) return false;
    return url.protocol === 'https:' || (url.protocol === 'http:' && localhost);
  } catch {
    return false;
  }
}

function ipv4Public(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if ((a === 192 && b === 0) || (a === 192 && b === 0) || (a === 198 && b === 51) || (a === 203 && b === 0)) return false;
  return true;
}

function ipv6Public(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  if (!value || value === '::' || value === '::1') return false;
  if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff')) return false;
  if (value.startsWith('2001:db8:')) return false;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Public(mapped[1]);
  return true;
}

function publicAddress(address) {
  const family = net.isIP(String(address || ''));
  return family === 4 ? ipv4Public(address) : family === 6 ? ipv6Public(address) : false;
}

function cimdUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('client_id must be a clean HTTPS Client ID Metadata Document URL');
  }
  return url;
}

async function resolvedPublicAddresses(hostname) {
  if (net.isIP(hostname)) {
    if (!publicAddress(hostname)) throw new Error('Client metadata address is not public');
    return [{ address: hostname, family: net.isIP(hostname) }];
  }
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !publicAddress(record.address))) {
    throw new Error('Client metadata hostname does not resolve exclusively to public addresses');
  }
  return records;
}

function pinnedHttpsJson(url, records) {
  return new Promise((resolve, reject) => {
    const selected = records[0];
    let settled = false;
    let bytes = 0;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const request = https.request(url, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': 'DevMate-CIMD/1' },
      lookup(_hostname, _options, callback) { callback(null, selected.address, selected.family); }
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status !== 200) {
        response.resume();
        fail(new Error(`Client metadata returned HTTP ${status}`));
        return;
      }
      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json' && !contentType.endsWith('+json')) {
        response.resume();
        fail(new Error('Client metadata must use a JSON content type'));
        return;
      }
      const advertised = Number(response.headers['content-length']);
      if (Number.isFinite(advertised) && advertised > MAX_CIMD_BYTES) {
        response.destroy();
        fail(new Error('Client metadata document is too large'));
        return;
      }
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_CIMD_BYTES) {
          response.destroy();
          fail(new Error('Client metadata document is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        if (settled) return;
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settled = true;
          resolve(value);
        } catch {
          fail(new Error('Client metadata document is not valid JSON'));
        }
      });
    });
    request.setTimeout(CIMD_FETCH_TIMEOUT_MS, () => request.destroy(new Error('Client metadata request timed out')));
    request.on('error', fail);
    request.end();
  });
}

function validateClientMetadata(value, expectedClientId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Client metadata must be a JSON object');
  if (String(value.client_id || '') !== expectedClientId) throw new Error('Client metadata client_id does not match the requested client_id');
  const clientName = String(value.client_name || '').trim();
  if (!clientName || clientName.length > 200) throw new Error('Client metadata requires a bounded client_name');
  if (!Array.isArray(value.redirect_uris) || !value.redirect_uris.length || value.redirect_uris.length > 20) {
    throw new Error('Client metadata requires redirect_uris');
  }
  const redirectUris = [...new Set(value.redirect_uris.map(String))];
  if (redirectUris.some(uri => !isRedirectUriAllowed(uri))) throw new Error('Client metadata contains an unsafe redirect URI');
  if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== 'none') {
    throw new Error('DevMate accepts public CIMD clients with token_endpoint_auth_method=none only');
  }
  if (value.response_types !== undefined && (!Array.isArray(value.response_types) || !value.response_types.includes('code'))) {
    throw new Error('Client metadata does not support the authorization-code response type');
  }
  if (value.grant_types !== undefined && (!Array.isArray(value.grant_types) || !value.grant_types.includes('authorization_code'))) {
    throw new Error('Client metadata does not support the authorization_code grant');
  }
  return { client_id: expectedClientId, client_name: clientName, redirect_uris: redirectUris };
}

async function clientMetadata(clientId) {
  const url = cimdUrl(clientId);
  const key = url.toString();
  const cached = cimdCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const records = await resolvedPublicAddresses(url.hostname);
  const raw = await pinnedHttpsJson(url, records);
  const value = validateClientMetadata(raw, key);
  if (cimdCache.size >= MAX_CIMD_CACHE) {
    const oldest = [...cimdCache.entries()].sort(([, a], [, b]) => a.expiresAt - b.expiresAt)[0];
    if (oldest) cimdCache.delete(oldest[0]);
  }
  cimdCache.set(key, { value, expiresAt: Date.now() + CIMD_CACHE_TTL_MS });
  return value;
}

async function requestParameters(req) {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') throw new Error('OAuth POST requests must use application/x-www-form-urlencoded');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_OAUTH_REQUEST_BYTES) throw new Error('OAuth request is too large');
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function requestedScope(parameters) {
  const scopes = [...new Set(String(parameters.get('scope') || 'devmate').split(/\s+/).filter(Boolean))];
  if (!scopes.includes('devmate')) throw new Error('The devmate scope is required');
  if (scopes.some(scope => !['devmate', 'offline_access'].includes(scope))) throw new Error('An unsupported OAuth scope was requested');
  return scopes.join(' ');
}

async function authorizeParameters(parameters, req) {
  if (parameters.get('response_type') !== 'code') throw new Error('Only authorization_code is supported');
  const clientId = cimdUrl(parameters.get('client_id')).toString();
  const client = await clientMetadata(clientId);
  const redirectUri = String(parameters.get('redirect_uri') || '');
  if (!client.redirect_uris.includes(redirectUri)) throw new Error('The redirect_uri is not declared by the client metadata document');
  if (parameters.get('code_challenge_method') !== 'S256' || !String(parameters.get('code_challenge') || '').trim()) {
    throw new Error('PKCE S256 is required');
  }
  const audience = mcpAudience(req);
  if (String(parameters.get('resource') || '') !== audience) throw new Error('The requested resource does not match this DevMate MCP server');
  return { audience, clientId, client, redirectUri, scope: requestedScope(parameters) };
}

function authorizeCredential(value, config) {
  const credential = String(value || '').trim();
  const secrets = readOAuthSecrets(CONFIG_PATH);
  if (equal(credential, secrets.ownerApprovalCode)) {
    return { subject: 'owner', authVersion: null, ownerApprovalCode: credential };
  }
  const member = verifyMemberLoginCode(credential, config);
  if (!member) return null;
  return { subject: `member:${member.id}`, authVersion: member.authVersion, ownerApprovalCode: null };
}

function touchMember(subject) {
  const match = String(subject || '').match(/^member:([a-z0-9_-]{1,120})$/);
  if (!match) return;
  try {
    mutateConfig(config => {
      normalizeInstanceConfig(config);
      const member = config.team.members.find(item => item.id === match[1]);
      if (member && !member.disabled) member.lastUsedAt = new Date().toISOString();
      return config;
    }, { retries: 4 });
  } catch {}
}

function issueAuthorizationCode(details, parameters, identity, req) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(18).toString('base64url');
  const exp = now + CODE_TTL_SECONDS;
  const secrets = readOAuthSecrets(CONFIG_PATH);
  const code = seal('dmocd', {
    aud: details.audience,
    av: identity.authVersion,
    cc: String(parameters.get('code_challenge') || ''),
    clientId: details.clientId,
    exp,
    iss: originFor(req),
    nonce,
    redirectUri: details.redirectUri,
    scope: details.scope,
    sub: identity.subject
  }, secrets.signingKey);
  registerAuthorizationCode(nonce, new Date(exp * 1000).toISOString());
  return { code, nonce };
}

function redirectWithCode(req, parameters, details, code) {
  const redirect = new URL(details.redirectUri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('iss', originFor(req));
  const state = parameters.get('state');
  if (state) redirect.searchParams.set('state', state);
  return redirect.toString();
}

function currentPrincipal(subject, authVersion) {
  const config = normalizeInstanceConfig(readConfig());
  return principalFromOAuthClaims({ sub: subject, av: authVersion }, config);
}

function tokenSet({ audience, issuer, scope, subject, authVersion, clientId, family = null }) {
  const secrets = readOAuthSecrets(CONFIG_PATH);
  const result = {
    access_token: issueAccessToken(secrets.signingKey, { audience, issuer, scope, subject, authVersion }),
    expires_in: 3600,
    scope,
    token_type: 'Bearer'
  };
  if (!scope.split(/\s+/).includes('offline_access')) return result;
  const activeFamily = family || createRefreshFamily({ subject, authVersion, clientId, audience, scope });
  result.refresh_token = issueRefreshToken(secrets.signingKey, {
    audience,
    issuer,
    scope,
    subject,
    authVersion,
    familyId: activeFamily.id,
    generation: activeFamily.generation
  });
  return result;
}

async function tokenEndpoint(req, res) {
  let parameters;
  try { parameters = await requestParameters(req); }
  catch (error) { json(res, 400, { error: 'invalid_request', error_description: error.message || String(error) }); return; }
  const audience = mcpAudience(req);
  const issuer = originFor(req);
  if (String(parameters.get('resource') || '') !== audience) {
    json(res, 400, { error: 'invalid_target', error_description: 'resource must match this MCP server' });
    return;
  }
  let clientId;
  try { clientId = cimdUrl(parameters.get('client_id')).toString(); }
  catch (error) { json(res, 400, { error: 'invalid_client', error_description: error.message }); return; }
  const secrets = readOAuthSecrets(CONFIG_PATH);
  const grant = parameters.get('grant_type');

  if (grant === 'authorization_code') {
    const code = unseal(parameters.get('code'), 'dmocd', secrets.signingKey);
    const now = Math.floor(Date.now() / 1000);
    const valid = code && Number.isInteger(code.exp) && code.exp > now && code.aud === audience && code.iss === issuer &&
      code.clientId === clientId && code.redirectUri === parameters.get('redirect_uri') &&
      sha256base64url(parameters.get('code_verifier')) === code.cc && currentPrincipal(code.sub, code.av);
    if (!valid || !consumeAuthorizationCode(code?.nonce)) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    try {
      json(res, 200, tokenSet({ audience, issuer, scope: code.scope, subject: code.sub, authVersion: code.av, clientId }));
    } catch {
      json(res, 400, { error: 'invalid_grant' });
    }
    return;
  }

  if (grant === 'refresh_token') {
    const refresh = verifyRefreshToken(secrets.signingKey, parameters.get('refresh_token'), audience, issuer);
    if (!refresh || !currentPrincipal(refresh.sub, refresh.av)) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    try {
      const family = consumeRefreshFamily({
        familyId: refresh.fid,
        generation: refresh.gen,
        subject: refresh.sub,
        authVersion: refresh.av,
        clientId,
        audience,
        scope: refresh.scope
      });
      json(res, 200, tokenSet({
        audience,
        issuer,
        scope: refresh.scope,
        subject: refresh.sub,
        authVersion: refresh.av,
        clientId,
        family
      }));
    } catch {
      json(res, 400, { error: 'invalid_grant' });
    }
    return;
  }

  json(res, 400, { error: 'unsupported_grant_type' });
}

async function revokeEndpoint(req, res) {
  let parameters;
  try { parameters = await requestParameters(req); }
  catch (error) { json(res, 400, { error: 'invalid_request', error_description: error.message || String(error) }); return; }
  const audience = mcpAudience(req);
  const issuer = originFor(req);
  if (String(parameters.get('resource') || '') !== audience) {
    json(res, 400, { error: 'invalid_target' });
    return;
  }
  const secrets = readOAuthSecrets(CONFIG_PATH);
  const refresh = verifyRefreshToken(secrets.signingKey, parameters.get('token'), audience, issuer);
  if (refresh) revokeRefreshFamily(refresh.fid, 'client_revocation');
  json(res, 200, {});
}

export function oauthResourceMetadataUrl(req) {
  return `${originFor(req)}/.well-known/oauth-protected-resource/mcp`;
}

export function oauthAccessToken(config, token, req) {
  if (config?.auth?.mode !== 'oauth') return null;
  const secrets = readOAuthSecrets(CONFIG_PATH);
  return verifyAccessToken(secrets.signingKey, token, mcpAudience(req), originFor(req));
}

export async function handleOAuthRequest(req, res, url, config) {
  if (config.auth?.mode !== 'oauth' || !oauthRequestPath(url)) return false;
  if (!hostAllowed(req, config)) {
    json(res, 421, { error: 'invalid_request', error_description: 'OAuth request host is not allowed' });
    return true;
  }
  const origin = originFor(req);
  if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
    json(res, 200, protectedResourceMetadata(req));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
    json(res, 200, authorizationServerMetadata(origin));
    return true;
  }
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    try {
      const details = await authorizeParameters(url.searchParams, req);
      html(res, 200, formPage(url.searchParams, details.client));
    } catch (error) {
      html(res, 400, formPage(url.searchParams, null, error.message || String(error)));
    }
    return true;
  }
  if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
    let parameters;
    try { parameters = await requestParameters(req); }
    catch (error) { html(res, 400, formPage(new URLSearchParams(), null, error.message || String(error))); return true; }
    let details;
    try { details = await authorizeParameters(parameters, req); }
    catch (error) { html(res, 400, formPage(parameters, null, error.message || String(error))); return true; }
    const currentConfig = normalizeInstanceConfig(readConfig());
    const identity = authorizeCredential(parameters.get('authorization_code'), currentConfig);
    if (!identity) {
      html(res, 401, formPage(parameters, details.client, 'The authorization code is invalid.'));
      return true;
    }
    let issued;
    try {
      issued = issueAuthorizationCode(details, parameters, identity, req);
      if (identity.ownerApprovalCode) {
        try { rotateOwnerApprovalCode(CONFIG_PATH, identity.ownerApprovalCode); }
        catch (error) { consumeAuthorizationCode(issued.nonce); throw error; }
      }
      touchMember(identity.subject);
    } catch (error) {
      html(res, 409, formPage(parameters, details.client, error.message || String(error)));
      return true;
    }
    res.writeHead(302, { location: redirectWithCode(req, parameters, details, issued.code), 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    await tokenEndpoint(req, res);
    return true;
  }
  if (url.pathname === '/oauth/revoke' && req.method === 'POST') {
    await revokeEndpoint(req, res);
    return true;
  }
  return false;
}

export const __test = {
  OAUTH_REQUEST_PATHS,
  authorizationServerMetadata,
  cimdUrl,
  oauthRequestPath,
  originFor,
  protectedResourceMetadata,
  publicAddress,
  validateClientMetadata
};
