import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import tokens from './platform/oauth-tokens.cjs';
import { DomainError } from './store.mjs';
import { clientMetadataUrl, configuredClientId, createClientMetadataResolver, matchRedirectUri, usableRedirect, validateClientMetadata } from './auth-client.mjs';

// Lifetimes in seconds. An access token is short. A grant with a refresh token lives
// while its client keeps using it: every refresh moves the idle deadline, up to an
// absolute age after which the owner signs in again.
export const ACCESS_TOKEN_SECONDS = 900;
export const GRANT_IDLE_SECONDS = 30 * 86400;
export const GRANT_MAX_SECONDS = 180 * 86400;
export const AUTHORIZATION_CODE_SECONDS = 300;
export const VERIFICATION_MAX_SECONDS = 120;
// One-time code form: wrong codes allowed per window, for one sign-in and for all of them.
export const ATTEMPT_WINDOW_SECONDS = 60;
export const REQUEST_ATTEMPTS = 5;
export const GLOBAL_ATTEMPTS = 30;

const OWNER = Object.freeze({ id: 'owner', role: 'owner', projectIds: null });
const VERIFICATION_CLIENT = 'devmate:route-verification';
const VERIFICATION_SUBJECT = 'devmate:verification';
const OAUTH_ERRORS = ['invalid_request', 'invalid_client', 'invalid_target', 'invalid_grant', 'invalid_scope', 'access_denied', 'unsupported_grant_type', 'unsupported_response_type'];
const paths = new Set(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp', '/oauth/authorize', '/oauth/token', '/oauth/revoke']);
const now = () => Math.floor(Date.now() / 1000);
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const secret = prefix => prefix + '_' + randomBytes(32).toString('base64url');
const fault = (code, message) => new DomainError(code, message);
const id = z.string().min(1).max(160);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STYLE = '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}' +
  'input{display:block;width:100%;box-sizing:border-box;margin:.5rem 0 1rem;padding:.5rem;font:inherit}button{padding:.5rem 1rem;font:inherit}' +
  '.notice{border-left:4px solid #b00020;padding-left:.75rem}code{word-break:break-all}</style>';
function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(JSON.stringify(value));
}
// formAction lists what the page's form may reach besides this server.
function html(res, status, title, body, { formAction = '', headers = {} } = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'" + (formAction && ' ' + formAction) + "; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', ...headers });
  res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>' + escape(title) + '</title>' +
    STYLE + '</head><body><h1>' + escape(title) + '</h1>' + body + '</body></html>');
}
// Chromium applies form-action to the redirect that answers a form post, so the page
// has to allow the client's redirect origin or the browser drops the sign-in after the
// one-time code was already spent. CSP cannot name an IPv6 host; that case allows the scheme.
function redirectSource(redirectUri) {
  const url = new URL(redirectUri);
  return url.hostname.startsWith('[') ? url.protocol : url.origin;
}
function signingKey(instanceRoot) {
  if (!path.isAbsolute(instanceRoot || '')) throw fault('invalid_instance', 'An absolute instance directory is required.');
  fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
  const filename = path.join(instanceRoot, 'oauth-signing-key');
  if (!fs.existsSync(filename)) {
    let fd;
    try {
      fd = fs.openSync(filename, 'wx', 0o600);
      fs.writeFileSync(fd, randomBytes(48).toString('base64url')); fs.fsyncSync(fd);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128) throw fault('invalid_auth_key', 'OAuth key storage is invalid.');
  const value = fs.readFileSync(filename, 'utf8');
  if (!/^[A-Za-z0-9_-]{64}$/.test(value)) throw fault('invalid_auth_key', 'OAuth key is invalid; it was not regenerated.');
  if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
  return value;
}
async function parameters(req) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim() !== 'application/x-www-form-urlencoded') throw fault('invalid_request', 'Use application/x-www-form-urlencoded.');
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) throw fault('invalid_request', 'OAuth request is too large.'); chunks.push(chunk); }
  return uniqueParameters(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}
function uniqueParameters(value) {
  for (const key of new Set(value.keys())) if (value.getAll(key).length !== 1) throw fault('invalid_request', 'Duplicate OAuth parameter.');
  return value;
}
function requiredScope(value) {
  const values = [...new Set((value || 'devmate').split(/\s+/).filter(Boolean))];
  if (!values.includes('devmate') || values.some(s => !['devmate', 'offline_access'].includes(s))) throw fault('invalid_scope', 'Supported scopes are devmate and offline_access; devmate is required.');
  return values.join(' ');
}
function publicMember(value) {
  return { id: value.id, name: value.name, role: value.role, projectIds: value.projectIds, disabled: value.disabled,
    revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}
// Failed one-time codes, counted in fixed windows. One sign-in (a client and its PKCE
// challenge) is paused after REQUEST_ATTEMPTS. Past GLOBAL_ATTEMPTS overall, wrong codes
// are answered without a retry form, but a correct code still signs in: a flood of
// guesses cannot lock the owner out, and guessing a 256-bit code is not a risk.
function createAttemptLimiter() {
  const windows = new Map();
  const live = key => { const item = windows.get(key); if (item && item.resetAt <= now()) { windows.delete(key); return null; } return item || null; };
  const count = key => { const item = live(key) || { count: 0, resetAt: now() + ATTEMPT_WINDOW_SECONDS }; item.count++; windows.set(key, item); return item; };
  return {
    retryAfter(key) { const item = live(key); return item && item.count >= REQUEST_ATTEMPTS ? item.resetAt - now() : 0; },
    failed(key) {
      for (const candidate of [...windows.keys()]) live(candidate);
      const all = count('*');
      if (all.count > GLOBAL_ATTEMPTS) return { global: true, retryAfter: all.resetAt - now() };
      const own = count(key);
      if (own.count >= REQUEST_ATTEMPTS) own.resetAt = now() + ATTEMPT_WINDOW_SECONDS;
      return { remaining: Math.max(0, REQUEST_ATTEMPTS - own.count), retryAfter: own.count >= REQUEST_ATTEMPTS ? ATTEMPT_WINDOW_SECONDS : 0 };
    },
    clear(key) { windows.delete(key); }
  };
}

export function createAuth({ store, instanceRoot, config = {}, clientMetadata } = {}) {
  const mode = config.mode || 'none';
  if (!['none', 'oauth'].includes(mode)) throw fault('unsupported_auth', 'Choose none or oauth.');
  let issuer = null, key = null;
  if (mode === 'oauth') {
    let parsed;
    try { parsed = new URL(config.issuer); } catch { throw fault('invalid_issuer', 'OAuth requires an explicit HTTPS issuer origin.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw fault('invalid_issuer', 'OAuth issuer must be an explicit HTTPS origin.');
    issuer = parsed.origin; key = signingKey(instanceRoot);
  }
  const resource = issuer ? issuer + '/mcp' : null;
  // Clients the owner registered in the configuration, by client_id: public clients like
  // any other, known here without a metadata document. The configuration validates them;
  // what sign-in relies on is checked again, so nothing else can put one in this list.
  const configured = new Map();
  for (const item of (mode === 'oauth' && config.clients) || []) {
    if (!configuredClientId(item?.clientId) || configured.has(item.clientId) || !Array.isArray(item.redirectUris) || !item.redirectUris.length || !item.redirectUris.every(usableRedirect))
      throw fault('invalid_auth_client', 'Each configured OAuth client needs its own plain clientId and HTTPS or loopback redirectUris.');
    // The owner registered it on purpose, so it stays signed in like any client that declares the refresh grant:
    // without that, a client that never asks for offline_access would have to sign in again every few minutes.
    configured.set(item.clientId, { client_name: item.name, redirect_uris: [...item.redirectUris], grant_types: ['authorization_code', 'refresh_token'], configured: true });
  }
  const resolveMetadata = clientMetadata || createClientMetadataResolver();
  const attempts = createAttemptLimiter(), timers = new Set();
  const findCode = (value, purpose) => {
    if (typeof value !== 'string' || value.length > 256) return null;
    const row = store.db.prepare("SELECT data FROM entities WHERE kind='auth-code' AND json_extract(data,'$.hash')=? AND json_extract(data,'$.purpose')=?")
      .get(hash(value), purpose);
    return row ? JSON.parse(row.data) : null;
  };
  const get = (kind, value) => { try { return store.get(kind, value); } catch (error) { if (error.code === 'not_found') return null; throw error; } };
  function identity(subject, version) {
    if (subject === 'owner') return version === 1 ? { ...OWNER } : null;
    // The runtime's own check of its public route: allowed to ask which runtime answers, and nothing else.
    if (subject === VERIFICATION_SUBJECT) return version === 1 ? { id: 'verification', role: 'read', projectIds: [] } : null;
    const member = get('auth-member', subject);
    if (!member || member.disabled || member.authVersion !== version || !['write', 'read'].includes(member.role)) return null;
    return { id: member.id, role: member.role, projectIds: [...member.projectIds], authVersion: member.authVersion };
  }
  function revokeMember(memberId) {
    const rows = store.db.prepare("SELECT id FROM entities WHERE kind='auth-grant' AND json_extract(data,'$.subject')=? AND json_extract(data,'$.status')='active'").all(memberId);
    for (const row of rows) store.update('auth-grant', row.id, { status: 'revoked', reason: 'identity_changed' });
  }
  function validateProjects(projectIds) {
    const values = [...new Set(projectIds)]; for (const projectId of values) store.get('project', projectId); return values;
  }
  // This server protects one resource, so a request that names none means that one
  // (RFC 8707 section 2.1); a request that names another is refused.
  function checkResource(params) {
    if (!params.has('resource')) return;
    let url;
    try { url = new URL(params.get('resource')); } catch {}
    if (!url || url.origin !== issuer || url.pathname !== '/mcp' || url.search || url.hash || url.username || url.password)
      throw fault('invalid_target', 'resource must be ' + resource + ' (or be omitted).');
  }
  function sweepVerificationGrants() {
    const rows = store.db.prepare("SELECT id FROM entities WHERE kind='auth-grant' AND json_extract(data,'$.purpose')='verification' AND json_extract(data,'$.expiresAt')<=?").all(now());
    for (const row of rows) store.remove('auth-grant', row.id);
  }
  const operations = [];
  const add = (name, shape, readOnly, description, run) => {
    const schema = z.object(shape).strict();
    operations.push({ name, schema, description, localOnly: true, readOnly, run: input => run(schema.parse(input || {})) });
  };
  add('auth.status', {}, true, 'Inspect optional OAuth identity configuration without revealing credentials.', () => ({ mode, issuer, resource }));
  add('auth.member.list', {}, true, 'List local OAuth identities.', () => ({ items: store.list('auth-member', { limit: 10000 }).map(publicMember) }));
  add('auth.member.create', { name: z.string().trim().min(1).max(200), role: z.enum(['write', 'read']), projectIds: z.array(id).max(1000) }, false,
    'Create a scoped OAuth identity; no login credential is returned until auth.code.create.', args => publicMember(store.create('auth-member', { ...args, projectIds: validateProjects(args.projectIds), disabled: false, authVersion: 1 })));
  add('auth.member.update', { id, name: z.string().trim().min(1).max(200).optional(), role: z.enum(['write', 'read']).optional(),
    projectIds: z.array(id).max(1000).optional(), disabled: z.boolean().optional(), expectedRevision: z.number().int().positive().optional() }, false,
    'Update an identity and immediately invalidate its previous authorization.', args => store.transaction(() => {
      const member = store.get('auth-member', args.id), patch = { authVersion: member.authVersion + 1 };
      for (const field of ['name', 'role', 'disabled']) if (args[field] !== undefined) patch[field] = args[field];
      if (args.projectIds !== undefined) patch.projectIds = validateProjects(args.projectIds);
      const result = store.update('auth-member', args.id, patch, args.expectedRevision); revokeMember(args.id);
      return publicMember(result);
    }));
  add('auth.member.remove', { id }, false, 'Remove an OAuth identity and revoke its grants.', args => store.transaction(() => { revokeMember(args.id); return store.remove('auth-member', args.id); }));
  add('auth.code.create', { memberId: id.optional(), ttlSeconds: z.number().int().min(60).max(900).default(600) }, false,
    'Create a one-time authorization login code. The secret is returned only by this local call.', args => {
      if (mode !== 'oauth') throw fault('oauth_disabled', 'Enable OAuth with an explicit HTTPS issuer first.');
      const member = args.memberId ? store.get('auth-member', args.memberId) : null;
      if (member?.disabled) throw fault('identity_disabled', 'This identity is disabled.');
      const subject = member?.id || 'owner', authVersion = member?.authVersion || 1;
      const code = secret('dml'), expiresAt = now() + args.ttlSeconds;
      store.create('auth-code', { purpose: 'login', hash: hash(code), subject, authVersion, expiresAt, status: 'active' });
      return { code, expiresAt: new Date(expiresAt * 1000).toISOString(), principal: identity(subject, authVersion) };
    });
  add('auth.grant.list', { limit: z.number().int().min(1).max(500).default(100) }, true,
    'List the newest OAuth grants, newest first, without returning token material. purpose is client, or verification for the short-lived grant the runtime uses to check its own public route.', args => ({
      items: store.list('auth-grant', { newestFirst: true, limit: args.limit }).map(grant => ({ id: grant.id, purpose: grant.purpose, subject: grant.subject, clientId: grant.clientId, scope: grant.scope,
        status: grant.status === 'active' && grant.expiresAt <= now() ? 'expired' : grant.status, ...(grant.reason ? { reason: grant.reason } : {}),
        expiresAt: grant.expiresAt, createdAt: grant.createdAt, updatedAt: grant.updatedAt })) }));
  add('auth.grant.revoke', { id }, false, 'Revoke an OAuth grant and its access and refresh tokens.', args => {
    const value = store.update('auth-grant', args.id, { status: 'revoked', reason: 'owner_revocation' });
    return { id: value.id, status: value.status };
  });

  // principal is the caller, or null. reason is null when the request carried no
  // bearer token and says why when it carried one that is not accepted.
  function check(req) {
    if (mode === 'none') return { principal: { ...OWNER }, reason: null };
    const rejected = reason => ({ principal: null, reason });
    const authorization = req.headers?.authorization;
    if (typeof authorization !== 'string' || !/^Bearer /i.test(authorization)) return rejected(null);
    if (authorization.length > 16384 || !/^Bearer [^\s]+$/i.test(authorization)) return rejected('The access token is malformed.');
    const claims = tokens.verifyAccessToken(key, authorization.slice(7), resource, issuer);
    if (!claims) return rejected('The access token is invalid or expired.');
    const grant = get('auth-grant', claims.fid);
    if (!grant || grant.status !== 'active' || grant.expiresAt <= now() || grant.subject !== claims.sub || grant.authVersion !== claims.av || grant.scope !== claims.scope)
      return rejected('The sign-in behind this access token was revoked or has expired.');
    const principal = identity(claims.sub, claims.av);
    return principal ? { principal, reason: null } : rejected('The identity behind this access token was changed or disabled.');
  }
  const authenticate = req => check(req).principal;
  // The WWW-Authenticate value for a 401 from the MCP endpoint (RFC 6750 section 3, RFC 9728 section 5.1).
  function challenge(reason) {
    if (mode !== 'oauth') return null;
    const fields = reason ? ['error="invalid_token"', 'error_description="' + String(reason).replace(/[^\x20\x21\x23-\x5b\x5d-\x7e]/g, '') + '"'] : [];
    return 'Bearer ' + [...fields, 'resource_metadata="' + issuer + '/.well-known/oauth-protected-resource/mcp"', 'scope="devmate"'].join(', ');
  }
  async function authorizationDetails(params) {
    // A client the owner registered is known by its name, and nothing is fetched for it.
    let clientId = params.get('client_id'), client = configured.get(clientId);
    if (!client) {
      try { clientId = clientMetadataUrl(clientId).href; } catch (error) { throw fault('invalid_client', error instanceof TypeError ? 'client_id must be an HTTPS Client ID Metadata Document URL, or a client registered in the configuration of this DevMate.' : error.message); }
      try { client = validateClientMetadata(await resolveMetadata(clientId), clientId); } catch (error) { throw fault('invalid_client', 'The client could not be verified from ' + clientId + '. ' + error.message); }
    }
    const redirectUri = params.get('redirect_uri');
    if (!matchRedirectUri(client.redirect_uris, redirectUri)) throw fault('invalid_request', client.configured ? 'redirect_uri is not one registered for this client in the configuration of this DevMate.' : 'redirect_uri is not one the client declares.');
    // The client and its redirect are now verified, so an error page may offer the way back to it.
    try {
      if ((params.get('state') || '').length > 2048) throw fault('invalid_request', 'state exceeds its bound.');
      if (params.get('response_type') !== 'code') throw fault('unsupported_response_type', 'Only response_type=code is supported.');
      checkResource(params);
      const codeChallenge = params.get('code_challenge');
      if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge || '')) throw fault('invalid_request', 'A valid PKCE S256 challenge is required.');
      const scope = requiredScope(params.get('scope'));
      // Whether to issue a refresh token is this server's decision: a client that declares
      // the refresh_token grant gets one even when it did not ask for offline_access.
      const refreshable = client.grant_types.includes('refresh_token') || scope.split(' ').includes('offline_access');
      return { clientId, client, redirectUri, challenge: codeChallenge, scope, refreshable };
    } catch (error) {
      if (OAUTH_ERRORS.includes(error.code)) { error.redirectUri = redirectUri; error.state = (params.get('state') || '').length > 2048 ? null : params.get('state'); }
      throw error;
    }
  }
  function form(res, status, params, details, notice, headers) {
    const fields = ['client_id','redirect_uri','response_type','resource','code_challenge','code_challenge_method','scope','state']
      .filter(name => params.has(name)).map(name => '<input type="hidden" name="' + name + '" value="' + escape(params.get(name)) + '">').join('');
    const target = new URL(details.redirectUri);
    html(res, status, 'Authorize DevMate', (notice ? '<p class="notice">' + escape(notice) + '</p>' : '') +
      '<p><strong>' + escape(details.client.client_name) + '</strong> asks to use DevMate on this computer.</p><p>Client: <code>' + escape(details.clientId) + '</code></p>' +
      // A registered client does not describe itself: its name is the owner's word, not the client's.
      (details.client.configured ? '<p>The owner of this DevMate registered this client and chose its name. The client does not publish a description of itself.</p>' : '') +
      '<p>Return to: <strong>' + escape(target.host) + '</strong></p><p>Requested scope: ' + escape(details.scope) + '</p>' +
      (target.protocol === 'http:' ? '<p>This redirect returns to a local application. Confirm that you started this sign-in.</p>' : '') +
      '<form method="post" action="/oauth/authorize">' + fields + '<label>One-time DevMate code <input type="password" name="authorization_code" autocomplete="one-time-code" required autofocus></label>' +
      '<button type="submit">Authorize this client</button></form>', { formAction: redirectSource(details.redirectUri), headers });
  }
  // Before the owner has signed in nothing is redirected automatically: the page explains
  // the error and, once the redirect is verified, links back so the client learns of it.
  function errorPage(res, error) {
    const known = OAUTH_ERRORS.includes(error.code);
    const code = known ? error.code : 'server_error', description = known ? error.message : 'DevMate could not complete this sign-in.';
    let back = '';
    if (known && error.redirectUri) {
      const target = new URL(error.redirectUri);
      target.searchParams.set('error', code); target.searchParams.set('error_description', description); target.searchParams.set('iss', issuer);
      if (error.state) target.searchParams.set('state', error.state);
      back = '<p><a href="' + escape(target.href) + '">Return to ' + escape(target.host) + '</a> to tell the client.</p>';
    }
    html(res, known ? 400 : 500, 'Sign-in could not continue', '<p class="notice">' + escape(description) + '</p><p>Error: <code>' + code + '</code></p>' + back +
      '<p>Otherwise close this page and start the sign-in again from the client.</p>');
  }
  // The page is served with Referrer-Policy: no-referrer, and a browser then sends
  // "Origin: null" with its form post, so the origin alone cannot identify our own page.
  // Sec-Fetch-Site does; a browser too old to send it is judged by a named origin only.
  function foreignForm(req) {
    const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
    return (origin !== undefined && origin !== 'null' && origin !== issuer) || (site !== undefined && site !== 'same-origin');
  }
  async function authorize(req, res, url) {
    try {
      if (!['GET', 'POST'].includes(req.method)) throw fault('invalid_request', 'Open this page from the client that is signing in.');
      if (req.method === 'POST' && foreignForm(req)) throw fault('invalid_request', 'The sign-in form was submitted from another site.');
      const params = req.method === 'GET' ? uniqueParameters(url.searchParams) : await parameters(req);
      const details = await authorizationDetails(params);
      if (req.method === 'GET') return form(res, 200, params, details);
      // Everything about the request is valid here, so only the one-time code decides the outcome.
      const requestKey = hash(details.clientId + '\n' + details.challenge), paused = attempts.retryAfter(requestKey);
      const wait = seconds => 'Too many incorrect codes. Wait ' + seconds + ' seconds and try again.';
      if (paused) return form(res, 429, params, details, wait(paused), { 'Retry-After': String(paused) });
      const code = store.transaction(() => {
        const login = findCode(params.get('authorization_code'), 'login');
        if (!login || login.status !== 'active' || login.expiresAt <= now() || !identity(login.subject, login.authVersion)) return null;
        store.update('auth-code', login.id, { status: 'used' });
        const raw = secret('dmc');
        store.create('auth-code', { purpose: 'authorization', hash: hash(raw), subject: login.subject, authVersion: login.authVersion, clientId: details.clientId,
          redirectUri: details.redirectUri, challenge: details.challenge, scope: details.scope, refreshable: details.refreshable, expiresAt: now() + AUTHORIZATION_CODE_SECONDS, status: 'active' });
        return raw;
      });
      if (!code) {
        const failure = attempts.failed(requestKey);
        if (failure.global) return html(res, 429, 'Sign-in is busy', '<p class="notice">Too many failed sign-in attempts are reaching this DevMate. Wait ' + failure.retryAfter +
          ' seconds, then start the sign-in again from the client.</p>', { headers: { 'Retry-After': String(failure.retryAfter) } });
        if (failure.retryAfter) return form(res, 429, params, details, wait(failure.retryAfter), { 'Retry-After': String(failure.retryAfter) });
        return form(res, 403, params, details, 'That one-time code is not valid: it was mistyped, already used or has expired. Create a new code in DevMate if needed. ' +
          failure.remaining + (failure.remaining === 1 ? ' attempt' : ' attempts') + ' left before a short pause.');
      }
      attempts.clear(requestKey);
      const redirect = new URL(details.redirectUri); redirect.searchParams.set('code', code); redirect.searchParams.set('iss', issuer);
      if (params.has('state')) redirect.searchParams.set('state', params.get('state'));
      res.writeHead(302, { Location: redirect.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end();
    } catch (error) { errorPage(res, error); }
  }
  function tokenSet(grant) {
    const ttlSeconds = Math.min(ACCESS_TOKEN_SECONDS, grant.expiresAt - now());
    const claims = { audience: resource, issuer, scope: grant.scope, subject: grant.subject, authVersion: grant.authVersion, familyId: grant.id };
    const result = { access_token: tokens.issueAccessToken(key, { ...claims, ttlSeconds }), token_type: 'Bearer', expires_in: ttlSeconds, scope: grant.scope };
    if (grant.refreshable) {
      result.refresh_token = tokens.issueRefreshToken(key, { ...claims, generation: grant.generation, ttlSeconds: grant.expiresAt - now() });
      store.update('auth-grant', grant.id, { refreshHash: hash(result.refresh_token) });
    }
    return result;
  }
  // Clients are public: they identify themselves by client_id and prove the request with
  // PKCE or the rotating refresh token. Client authentication is never accepted.
  function publicClient(req, params) {
    if (req.headers.authorization !== undefined || ['client_secret', 'client_assertion', 'client_assertion_type'].some(name => params.has(name)))
      throw fault('invalid_client', 'This server accepts public clients only: send client_id without client authentication (token_endpoint_auth_method "none").');
    const clientId = params.get('client_id');
    if (configured.has(clientId)) return clientId;
    try { return clientMetadataUrl(clientId).href; } catch { throw fault('invalid_client', 'client_id must be the one used at authorization: a Client ID Metadata Document URL, or a client registered in the configuration of this DevMate.'); }
  }
  function exchange(req, params) {
    const clientId = publicClient(req, params);
    checkResource(params);
    // A failure is returned from the transaction, not thrown: a rollback must never undo
    // the revocation that a replayed code or refresh token triggers.
    if (params.get('grant_type') === 'authorization_code') {
      const issued = store.transaction(() => {
        const code = findCode(params.get('code'), 'authorization'), verifier = params.get('code_verifier') || '';
        // OAuth 2.1 no longer sends redirect_uri here; when a client does, it must be the one it authorized with.
        if (!code || code.clientId !== clientId || (params.has('redirect_uri') && params.get('redirect_uri') !== code.redirectUri) ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== code.challenge) return null;
        if (code.status !== 'active') {
          // A second, otherwise valid use of a code: what its first use issued is revoked (OAuth 2.1 section 4.1.3).
          const grant = code.grantId ? get('auth-grant', code.grantId) : null;
          if (grant?.status === 'active') store.update('auth-grant', grant.id, { status: 'revoked', reason: 'code_replay' });
          return null;
        }
        if (code.expiresAt <= now() || !identity(code.subject, code.authVersion)) return null;
        const issuedAt = now();
        const grant = store.create('auth-grant', { purpose: 'client', subject: code.subject, authVersion: code.authVersion, clientId, scope: code.scope, status: 'active', generation: 1,
          refreshable: code.refreshable === true, expiresAt: issuedAt + (code.refreshable === true ? GRANT_IDLE_SECONDS : ACCESS_TOKEN_SECONDS), maxExpiresAt: issuedAt + GRANT_MAX_SECONDS, refreshHash: null });
        store.update('auth-code', code.id, { status: 'used', grantId: grant.id });
        return tokenSet(grant);
      });
      if (!issued) throw fault('invalid_grant', 'The authorization code is invalid, expired or already used.');
      return issued;
    }
    if (params.get('grant_type') === 'refresh_token') {
      const raw = params.get('refresh_token'), claims = tokens.verifyRefreshToken(key, raw, resource, issuer);
      if (!claims || !identity(claims.sub, claims.av)) throw fault('invalid_grant', 'The refresh token is invalid or expired; sign in again.');
      const result = store.transaction(() => {
        const grant = get('auth-grant', claims.fid);
        if (!grant || grant.status !== 'active' || grant.expiresAt <= now() || grant.refreshable !== true) return { error: 'invalid_grant' };
        const revoke = reason => { store.update('auth-grant', grant.id, { status: 'revoked', reason }); return { error: 'invalid_grant' }; };
        // A genuine refresh token presented for another client, identity or scope has left its owner's hands.
        if (grant.clientId !== clientId || grant.subject !== claims.sub || grant.authVersion !== claims.av || grant.scope !== claims.scope) return revoke('refresh_binding_mismatch');
        if (grant.generation !== claims.gen || !tokens.equal(grant.refreshHash, hash(raw))) return revoke('refresh_reuse');
        const requested = (params.get('scope') || '').split(/\s+/).filter(Boolean);
        if (requested.some(value => !grant.scope.split(' ').includes(value))) return { error: 'invalid_scope' };
        return { tokens: tokenSet(store.update('auth-grant', grant.id, { generation: grant.generation + 1, expiresAt: Math.min(now() + GRANT_IDLE_SECONDS, grant.maxExpiresAt) })) };
      });
      if (result.error === 'invalid_scope') throw fault('invalid_scope', 'A refresh cannot add scopes beyond those originally granted.');
      if (result.error) throw fault('invalid_grant', 'The refresh token is invalid, expired or already used; sign in again.');
      return result.tokens;
    }
    throw fault('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.');
  }
  function revoke(req, params) {
    const clientId = publicClient(req, params), raw = params.get('token');
    if (!raw) throw fault('invalid_request', 'token is required.');
    const claims = tokens.verifyRefreshToken(key, raw, resource, issuer) || tokens.verifyAccessToken(key, raw, resource, issuer);
    const grant = claims ? get('auth-grant', claims.fid) : null;
    // RFC 7009: an unknown token is not an error, and a token is revoked only for the client it was issued to.
    if (grant?.status === 'active' && grant.clientId === clientId) store.update('auth-grant', grant.id, { status: 'revoked', reason: 'client_revocation' });
    return {};
  }
  async function handle(req, res, url) {
    if (mode !== 'oauth' || !paths.has(url.pathname)) return false;
    if (url.pathname === '/oauth/authorize') { await authorize(req, res, url); return true; }
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, MCP-Protocol-Version', 'Cache-Control': 'no-store' }); res.end();
      } else if (url.pathname.startsWith('/.well-known/')) {
        if (req.method !== 'GET') throw fault('invalid_request', 'GET required.');
        // offline_access is a matter between client and authorization server, so the
        // resource does not list it (MCP 2026-07-28 authorization, Refresh Tokens).
        if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) json(res, 200, { resource, authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['devmate'] });
        else json(res, 200, { issuer, authorization_endpoint: issuer + '/oauth/authorize', token_endpoint: issuer + '/oauth/token',
          revocation_endpoint: issuer + '/oauth/revoke', response_types_supported: ['code'], response_modes_supported: ['query'], grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'],
          scopes_supported: ['devmate', 'offline_access'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
      } else {
        if (req.method !== 'POST') throw fault('invalid_request', 'POST required.');
        const params = await parameters(req);
        json(res, 200, url.pathname === '/oauth/token' ? exchange(req, params) : revoke(req, params));
      }
    } catch (error) {
      const known = OAUTH_ERRORS.includes(error.code);
      // RFC 6749 section 5.2: a client that tried HTTP authentication is answered with 401 and that scheme.
      const attempted = known && error.code === 'invalid_client' && req.headers.authorization !== undefined;
      json(res, known ? (attempted ? 401 : 400) : 500, { error: known ? error.code : 'server_error', error_description: known ? error.message : 'The request could not be completed; try again.' },
        attempted ? { 'WWW-Authenticate': (/^Bearer /i.test(req.headers.authorization) ? 'Bearer' : 'Basic') + ' realm="DevMate"' } : {});
    }
    return true;
  }
  // A real, short-lived grant with no refresh token, for the runtime to connect to its own public URL as a
  // client would. It is sent to whatever answers at that URL, which may be the wrong server: so it carries no
  // access to any project. It is listed with purpose "verification" and removed once it has expired.
  function issueVerificationToken({ ttlSeconds = 60 } = {}) {
    if (mode !== 'oauth') throw fault('oauth_disabled', 'A verification token exists only with OAuth sign-in enabled.');
    const lifetime = Math.min(VERIFICATION_MAX_SECONDS, Math.max(5, Math.floor(Number(ttlSeconds)) || 60));
    sweepVerificationGrants();
    const expiresAt = now() + lifetime;
    const grant = store.create('auth-grant', { purpose: 'verification', subject: VERIFICATION_SUBJECT, authVersion: 1, clientId: VERIFICATION_CLIENT, scope: 'devmate', status: 'active', generation: 1,
      refreshable: false, expiresAt, maxExpiresAt: expiresAt, refreshHash: null });
    const timer = setTimeout(() => {
      timers.delete(timer);
      try { sweepVerificationGrants(); } catch { /* The store closed first; the next start sweeps. */ }
    }, (lifetime + 1) * 1000);
    timer.unref(); timers.add(timer);
    return { accessToken: tokenSet(grant).access_token, expiresAt: new Date(expiresAt * 1000).toISOString(), grantId: grant.id };
  }
  if (mode === 'oauth') sweepVerificationGrants();
  return { mode, issuer, resource, operations, handle, authenticate, check, challenge, issueVerificationToken,
    close() { for (const timer of timers) clearTimeout(timer); timers.clear(); resolveMetadata.close?.(); } };
}
