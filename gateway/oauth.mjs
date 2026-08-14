import crypto from 'node:crypto';
import tokens from '../shared/oauth-tokens.cjs';
import authConfig from '../shared/auth-config.cjs';
import { mutateConfig } from './local-shared.mjs';

const issuedCodes = new Map();
const CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_SECONDS = 5 * 60;

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function html(res, status, value) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' });
  res.end(value);
}

function escape(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function formPage(parameters, error = '') {
  const fields = [...parameters.entries()]
    .filter(([key]) => key !== 'approval_code')
    .map(([key, value]) => `<input type="hidden" name="${escape(key)}" value="${escape(value)}">`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize DevMate</title><style>body{font-family:system-ui,sans-serif;max-width:38rem;margin:10vh auto;padding:0 1.25rem;color:#18212b}input,button{font:inherit;padding:.7rem;width:100%;box-sizing:border-box}button{margin-top:1rem;background:#0b75b7;color:#fff;border:0;border-radius:.35rem}.error{color:#b42318}</style></head><body><h1>Authorize DevMate</h1><p>Enter the one-time DevMate OAuth approval code for this local instance.</p>${error ? `<p class="error">${escape(error)}</p>` : ''}<form method="post">${fields}<label>Approval code<input required autofocus autocomplete="one-time-code" name="approval_code" type="password"></label><button type="submit">Authorize</button></form></body></html>`;
}

function originFor(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwarded === 'https' ? 'https' : 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (!host || /[\s/\\@]/.test(host)) throw new Error('OAuth request has an invalid host');
  return `${protocol}://${host}`;
}

function mcpAudience(req) {
  return `${originFor(req)}/mcp`;
}

function authorizationServerMetadata(origin) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['devmate', 'offline_access']
  };
}

function protectedResourceMetadata(req) {
  const resource = mcpAudience(req);
  return {
    resource,
    authorization_servers: [originFor(req)],
    bearer_methods_supported: ['header'],
    scopes_supported: ['devmate', 'offline_access']
  };
}

function sha256base64url(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('base64url');
}

function oauthKey(config) {
  return String(config?.auth?.oauth?.signingKey || '');
}

function isRedirectUriAllowed(value) {
  try {
    const url = new URL(String(value || ''));
    const localhost = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname.toLowerCase());
    return url.protocol === 'https:' || (url.protocol === 'http:' && localhost);
  } catch {
    return false;
  }
}

function sealClient(config, redirectUris, applicationType = 'web') {
  const now = Math.floor(Date.now() / 1000);
  return tokens.seal('dmoc', {
    exp: now + CLIENT_TTL_SECONDS,
    iat: now,
    redirectUris,
    type: applicationType === 'native' ? 'native' : 'web'
  }, oauthKey(config));
}

function openClient(config, clientId) {
  const client = tokens.unseal(clientId, 'dmoc', oauthKey(config));
  if (!client || !Number.isInteger(client.exp) || client.exp <= Math.floor(Date.now() / 1000) || !Array.isArray(client.redirectUris)) return null;
  const redirectUris = client.redirectUris.filter(isRedirectUriAllowed);
  return redirectUris.length ? { ...client, redirectUris } : null;
}

function authorizeParameters(parameters, config, req) {
  const clientId = String(parameters.get('client_id') || '');
  const redirectUri = String(parameters.get('redirect_uri') || '');
  const client = openClient(config, clientId);
  const audience = mcpAudience(req);
  if (parameters.get('response_type') !== 'code') return { error: 'Only authorization_code is supported.' };
  if (!client || !client.redirectUris.includes(redirectUri)) return { error: 'The OAuth client or redirect URI is not registered.' };
  if (parameters.get('code_challenge_method') !== 'S256' || !String(parameters.get('code_challenge') || '').trim()) return { error: 'PKCE S256 is required.' };
  if (parameters.get('resource') !== audience) return { error: 'The requested resource does not match this DevMate MCP server.' };
  const requestedScopes = String(parameters.get('scope') || 'devmate').split(/\s+/).filter(Boolean);
  if (!requestedScopes.includes('devmate')) return { error: 'The devmate scope is required.' };
  if (requestedScopes.some(scope => !['devmate', 'offline_access'].includes(scope))) return { error: 'An unsupported OAuth scope was requested.' };
  return { audience, clientId, redirectUri, requestedScopes };
}

function issueAuthorizationCode(config, details) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('base64url');
  const code = tokens.seal('dmocd', {
    aud: details.audience,
    cc: details.codeChallenge,
    clientId: details.clientId,
    exp: now + CODE_TTL_SECONDS,
    nonce,
    redirectUri: details.redirectUri,
    scope: details.requestedScopes.join(' ')
  }, oauthKey(config));
  issuedCodes.set(nonce, now + CODE_TTL_SECONDS);
  if (issuedCodes.size > 1000) {
    for (const [key, expiresAt] of issuedCodes) if (expiresAt <= now) issuedCodes.delete(key);
  }
  return code;
}

function issueTokens(config, { audience, scope, subject = 'owner' }) {
  return {
    access_token: tokens.issueAccessToken(config, { audience, scope, subject }),
    expires_in: 3600,
    refresh_token: tokens.issueRefreshToken(config, { audience, scope, subject }),
    scope,
    token_type: 'Bearer'
  };
}

async function requestParameters(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('OAuth request is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    const value = JSON.parse(text || '{}');
    return new URLSearchParams(Object.entries(value && typeof value === 'object' ? value : {}).map(([key, value]) => [key, Array.isArray(value) ? JSON.stringify(value) : String(value ?? '')]));
  }
  return new URLSearchParams(text);
}

function redirectWithCode(req, parameters, details, config) {
  const code = issueAuthorizationCode(config, {
    ...details,
    codeChallenge: String(parameters.get('code_challenge') || '')
  });
  const redirect = new URL(details.redirectUri);
  redirect.searchParams.set('code', code);
  redirect.searchParams.set('iss', originFor(req));
  const state = parameters.get('state');
  if (state) redirect.searchParams.set('state', state);
  return redirect.toString();
}

function consumeApprovalCode(value) {
  mutateConfig(config => {
    if (config.auth?.mode !== 'oauth' || !tokens.equal(config.auth.oauth?.approvalCode, value)) {
      const error = new Error('The OAuth approval code has already been used or replaced.');
      error.code = 'oauth_approval_code_stale';
      throw error;
    }
    config.auth.oauth.approvalCode = authConfig.randomApprovalCode();
    return config;
  });
}

async function tokenEndpoint(req, res, config) {
  let parameters;
  try { parameters = await requestParameters(req); }
  catch (error) { json(res, 400, { error: 'invalid_request', error_description: error.message || String(error) }); return; }
  const audience = mcpAudience(req);
  const grant = parameters.get('grant_type');
  if (grant === 'authorization_code') {
    const code = tokens.unseal(parameters.get('code'), 'dmocd', oauthKey(config));
    const now = Math.floor(Date.now() / 1000);
    const client = openClient(config, parameters.get('client_id'));
    if (!code || !client || !Number.isInteger(code.exp) || code.exp <= now || !issuedCodes.delete(code.nonce) ||
      code.aud !== audience || code.clientId !== parameters.get('client_id') || code.redirectUri !== parameters.get('redirect_uri') ||
      sha256base64url(parameters.get('code_verifier')) !== code.cc) {
      json(res, 400, { error: 'invalid_grant' });
      return;
    }
    json(res, 200, issueTokens(config, { audience, scope: code.scope }));
    return;
  }
  if (grant === 'refresh_token') {
    const refresh = tokens.verifyRefreshToken(config, parameters.get('refresh_token'), audience);
    if (!refresh) { json(res, 400, { error: 'invalid_grant' }); return; }
    json(res, 200, issueTokens(config, { audience, scope: refresh.scope, subject: refresh.sub }));
    return;
  }
  json(res, 400, { error: 'unsupported_grant_type' });
}

export function oauthResourceMetadataUrl(req) {
  return `${originFor(req)}/.well-known/oauth-protected-resource/mcp`;
}

export function oauthAccessToken(config, token, req) {
  return tokens.verifyAccessToken(config, token, mcpAudience(req));
}

export function gatewayPreflightToken(config, publicUrl) {
  return tokens.preflightAccessToken(config, publicUrl);
}

export async function handleOAuthRequest(req, res, url, config) {
  if (config.auth?.mode !== 'oauth') return false;
  const origin = originFor(req);
  if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp')) {
    json(res, 200, protectedResourceMetadata(req));
    return true;
  }
  if (req.method === 'GET' && (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration')) {
    json(res, 200, authorizationServerMetadata(origin));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/oauth/register') {
    let parameters;
    try { parameters = await requestParameters(req); }
    catch (error) { json(res, 400, { error: 'invalid_client_metadata', error_description: error.message || String(error) }); return true; }
    let redirectUris = [];
    try { redirectUris = JSON.parse(parameters.get('redirect_uris') || '[]'); } catch {}
    if (!Array.isArray(redirectUris) || !redirectUris.length || redirectUris.some(uri => !isRedirectUriAllowed(uri))) {
      json(res, 400, { error: 'invalid_redirect_uri' });
      return true;
    }
    const clientId = sealClient(config, [...new Set(redirectUris.map(String))], parameters.get('application_type'));
    json(res, 201, { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: redirectUris, token_endpoint_auth_method: 'none' });
    return true;
  }
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    const details = authorizeParameters(url.searchParams, config, req);
    if (details.error) { html(res, 400, formPage(url.searchParams, details.error)); return true; }
    html(res, 200, formPage(url.searchParams));
    return true;
  }
  if (url.pathname === '/oauth/authorize' && req.method === 'POST') {
    const parameters = await requestParameters(req);
    const details = authorizeParameters(parameters, config, req);
    if (details.error) { html(res, 400, formPage(parameters, details.error)); return true; }
    if (!tokens.equal(parameters.get('approval_code'), config.auth.oauth.approvalCode)) {
      html(res, 401, formPage(parameters, 'The approval code is incorrect.'));
      return true;
    }
    const location = redirectWithCode(req, parameters, details, config);
    try { consumeApprovalCode(parameters.get('approval_code')); }
    catch (error) { html(res, 409, formPage(parameters, error.message || String(error))); return true; }
    res.writeHead(302, { location, 'cache-control': 'no-store' });
    res.end();
    return true;
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    await tokenEndpoint(req, res, config);
    return true;
  }
  return false;
}
