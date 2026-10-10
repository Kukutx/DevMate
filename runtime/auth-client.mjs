import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { publicAddress } from './platform/public-ip-policy.mjs';

// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00) as
// required by MCP 2026-07-28 authorization:
// https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
// https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;
// A fetched document is reused for as long as its Cache-Control allows, within these
// bounds. One sign-in reads the document more than once, so even "no-store" is held
// for the minimum.
export const CACHE_MIN_MS = 60 * 1000;
export const CACHE_DEFAULT_MS = 5 * 60 * 1000;
export const CACHE_MAX_MS = 24 * 60 * 60 * 1000;
// A failed fetch is not repeated for this long, so an unauthenticated authorization
// request cannot make this server hammer a host. A failure is never used as metadata.
export const FAILURE_MS = 10 * 1000;
export const MAX_PENDING = 32;
export const MAX_PENDING_PER_HOST = 2;
const MAX_ENTRIES = 500;
const SHARED_SECRET_METHODS = ['client_secret_basic', 'client_secret_post', 'client_secret_jwt'];

function loopback(hostname) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
}
// CIMD section 3: https, a path, no dot segments, fragment or credentials. A query is
// refused as well. Requiring the canonical spelling rejects dot segments and lets every
// later comparison of the identifier be a plain string comparison.
export function clientMetadataUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('client_id must be an HTTPS URL.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || /[?#]/.test(value) || url.pathname === '/' || url.href !== value)
    throw new Error('client_id must be a canonical HTTPS URL with a path and without query, fragment or credentials.');
  return url;
}
// A client the owner registers in the configuration (auth.clients) because it publishes
// no document: pre-registration, on the client-registration page above. Its identifier
// is a plain name. Without ":" and "/" it is never a URL, so it cannot be taken for a
// metadata document client or for an identifier this server uses itself.
export function configuredClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}
// A redirect this server is willing to use, whoever declared it: HTTPS, or plain HTTP
// to a loopback address, with no fragment and no credentials.
export function usableRedirect(uri) {
  // Written exactly as it will be compared: a space or a line break around it would be accepted by a URL parser and
  // then never match a real request.
  if (typeof uri !== 'string' || uri.length > 2048 || uri.includes('#') || uri !== uri.trim() || /\s/.test(uri)) return false;
  let url;
  try { url = new URL(uri); } catch { return false; }
  return !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback(url.hostname)));
}
// Exact string match, except that a loopback redirect may use any port: a native
// client listens on a port chosen at sign-in (RFC 8252 section 7.3, OAuth 2.1
// section 4.1.1). Scheme, host, path and query still have to match.
export function matchRedirectUri(declared, requested) {
  if (typeof requested !== 'string' || !usableRedirect(requested)) return false;
  if (declared.includes(requested)) return true;
  const url = new URL(requested);
  if (url.protocol !== 'http:') return false;
  return declared.some(item => {
    const known = new URL(item);
    return known.protocol === 'http:' && known.hostname === url.hostname && known.pathname === url.pathname && known.search === url.search;
  });
}
export function validateClientMetadata(value, clientId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.client_id !== clientId) throw new Error('The client_id in the document does not match its URL.');
  if (typeof value.client_name !== 'string' || !value.client_name.trim() || value.client_name.length > 200) throw new Error('The document needs a client_name of at most 200 characters.');
  if (!Array.isArray(value.redirect_uris) || !value.redirect_uris.length || value.redirect_uris.length > 20 || value.redirect_uris.some(uri => typeof uri !== 'string'))
    throw new Error('The document needs between 1 and 20 redirect_uris.');
  // A redirect this server would never use (another scheme, plain HTTP to a remote host)
  // is ignored rather than failing a client whose other redirects are fine.
  const redirectUris = [...new Set(value.redirect_uris)].filter(usableRedirect);
  if (!redirectUris.length) throw new Error('The document declares no HTTPS or loopback redirect URI.');
  // A document can name one method (RFC 7591) and list the ones the client is able to
  // use; the client then picks one this server advertises, which is only "none".
  const offered = value.token_endpoint_auth_methods_supported;
  if (offered !== undefined && (!Array.isArray(offered) || offered.some(method => typeof method !== 'string'))) throw new Error('token_endpoint_auth_methods_supported must be a list of method names.');
  const methods = [value.token_endpoint_auth_method, ...(offered || [])].filter(method => method !== undefined);
  if (value.client_secret !== undefined || value.client_secret_expires_at !== undefined || methods.some(method => SHARED_SECRET_METHODS.includes(method)))
    throw new Error('A metadata document client cannot use a shared secret.');
  if (methods.length && !methods.includes('none')) throw new Error('The client must be able to act as a public client (token endpoint auth method "none").');
  if (value.response_types !== undefined && (!Array.isArray(value.response_types) || !value.response_types.includes('code'))) throw new Error('The client must support response_type=code.');
  if (value.grant_types !== undefined && (!Array.isArray(value.grant_types) || !value.grant_types.includes('authorization_code'))) throw new Error('The client must support the authorization_code grant.');
  return { client_id: clientId, client_name: value.client_name.trim(), redirect_uris: redirectUris,
    grant_types: (value.grant_types || ['authorization_code']).filter(type => typeof type === 'string') };
}
function cacheLifetime(header) {
  const directives = String(header || '').toLowerCase().split(',').map(part => part.trim());
  if (directives.some(part => part === 'no-store' || part === 'no-cache' || part.startsWith('no-cache='))) return CACHE_MIN_MS;
  const maxAge = directives.map(part => /^max-age="?(\d{1,9})"?$/.exec(part)).find(Boolean);
  return maxAge ? Math.min(CACHE_MAX_MS, Math.max(CACHE_MIN_MS, Number(maxAge[1]) * 1000)) : CACHE_DEFAULT_MS;
}
function remember(map, key, entry) {
  map.delete(key);
  if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
  map.set(key, entry);
}
export function createClientMetadataResolver({ lookup = dns.lookup, request = https.request, timeoutMs = TIMEOUT_MS } = {}) {
  const budget = Math.max(1, Math.min(TIMEOUT_MS, Number(timeoutMs) || TIMEOUT_MS));
  const cache = new Map(), failures = new Map(), inflight = new Map(), pendingByHost = new Map();
  async function load(url) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const deadline = Date.now() + budget;
    let timer;
    const records = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await Promise.race([
      Promise.resolve(lookup(hostname, { all: true, verbatim: true })).catch(error => { throw new Error('Client metadata host could not be resolved' + (error?.code ? ' (' + error.code + ').' : '.')); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Client metadata DNS lookup timed out.')), budget); })
    ]).finally(() => clearTimeout(timer));
    if (!records.length || records.some(item => !publicAddress(item.address))) throw new Error('Client metadata must resolve exclusively to public addresses.');
    const response = await new Promise((resolve, reject) => {
      let finished = false, timer;
      const finish = (error, value) => { if (finished) return; finished = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const selected = records[0];
      // No shared agent: a pooled connection opened elsewhere would bypass the pinned address.
      const req = request(url, { method: 'GET', agent: false, headers: { accept: 'application/json', 'user-agent': 'DevMate-CIMD/4' },
        lookup(_hostname, options, callback) {
          // Newer Node versions may request all addresses. Always use the validated set.
          if (options?.all) callback(null, [{ address: selected.address, family: selected.family }]);
          else callback(null, selected.address, selected.family);
        }
      }, res => {
        if (res.statusCode !== 200) { res.destroy(); return finish(new Error('Client metadata requires HTTP 200; redirects are not followed.')); }
        const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json' && !contentType.endsWith('+json')) { res.destroy(); return finish(new Error('Client metadata requires JSON content type.')); }
        if (Number(res.headers['content-length']) > MAX_BYTES) { res.destroy(); return finish(new Error('Client metadata exceeds 64 KiB.')); }
        let bytes = 0; const chunks = [];
        res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_BYTES) { res.destroy(); finish(new Error('Client metadata exceeds 64 KiB.')); } else chunks.push(chunk); });
        res.on('error', () => finish(new Error('Client metadata response was interrupted.')));
        res.on('aborted', () => finish(new Error('Client metadata response was interrupted.')));
        res.on('end', () => {
          try { finish(null, { document: JSON.parse(Buffer.concat(chunks).toString('utf8')), lifetimeMs: cacheLifetime(res.headers['cache-control']) }); }
          catch { finish(new Error('Client metadata is invalid JSON.')); }
        });
      });
      timer = setTimeout(() => { req.destroy(); finish(new Error('Client metadata request timed out.')); }, Math.max(1, deadline - Date.now()));
      req.on('error', error => finish(new Error('Client metadata request failed' + (error?.code ? ' (' + error.code + ').' : '.')))); req.end();
    });
    return { value: validateClientMetadata(response.document, url.href), lifetimeMs: response.lifetimeMs };
  }
  async function resolve(clientId) {
    const url = clientMetadataUrl(clientId), key = url.href, host = url.hostname;
    const found = cache.get(key);
    if (found?.expiresAt > Date.now()) return found.value;
    const failed = failures.get(key);
    if (failed?.until > Date.now()) throw new Error(failed.message);
    if (inflight.has(key)) return inflight.get(key);
    if (inflight.size >= MAX_PENDING) throw new Error('Too many client metadata requests are in progress; try again shortly.');
    if ((pendingByHost.get(host) || 0) >= MAX_PENDING_PER_HOST) throw new Error('Too many client metadata requests to this host are in progress; try again shortly.');
    pendingByHost.set(host, (pendingByHost.get(host) || 0) + 1);
    const work = load(url).then(({ value, lifetimeMs }) => {
      failures.delete(key);
      remember(cache, key, { value, expiresAt: Date.now() + lifetimeMs });
      return value;
    }, error => {
      cache.delete(key);
      remember(failures, key, { message: error.message, until: Date.now() + FAILURE_MS });
      throw error;
    }).finally(() => {
      inflight.delete(key);
      if (pendingByHost.get(host) > 1) pendingByHost.set(host, pendingByHost.get(host) - 1); else pendingByHost.delete(host);
    });
    inflight.set(key, work); return work;
  }
  resolve.close = () => { cache.clear(); failures.clear(); };
  return resolve;
}
