import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Store } from '../runtime/store.mjs';
import { createAuth, ACCESS_TOKEN_SECONDS, GRANT_IDLE_SECONDS, GRANT_MAX_SECONDS, ATTEMPT_WINDOW_SECONDS, REQUEST_ATTEMPTS, GLOBAL_ATTEMPTS, VERIFICATION_MAX_SECONDS } from '../runtime/auth.mjs';
import { normalizeConfig, readConfig } from '../runtime/config.mjs';

const issuer = 'https://devmate.example';
const clientId = 'https://client.example/metadata.json';
const redirectUri = 'http://127.0.0.1:55123/callback';
const verifier = 'v'.repeat(64);
const s256 = value => createHash('sha256').update(value).digest('base64url');
const challenge = s256(verifier);
const metadata = { client_id: clientId, client_name: 'Fixture Client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
const seconds = () => Math.floor(Date.now() / 1000);
async function fixture(t, { config = { mode: 'oauth', issuer }, client = metadata } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-auth-'));
  const store = new Store(root), fetched = [];
  const clientMetadata = async id => { fetched.push(id); return client; };
  let auth = createAuth({ store, instanceRoot: root, config, clientMetadata });
  t.after(() => { auth.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const operation = (name, input = {}) => auth.operations.find(op => op.name === name).run(input);
  async function request(pathname, params = {}, { method = 'POST', headers = {} } = {}) {
    const encoded = new URLSearchParams(params);
    const url = new URL(pathname, issuer);
    if (method === 'GET') url.search = encoded;
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(encoded.toString())]);
    req.method = method; req.headers = { 'content-type': 'application/x-www-form-urlencoded', ...headers };
    const response = { status: null, headers: {}, text: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value = '') { this.text += value; } };
    const handled = await auth.handle(req, response, url);
    let json; try { json = JSON.parse(response.text); } catch {}
    return { ...response, json, handled };
  }
  const query = (extra = {}) => ({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp',
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'devmate offline_access', state: 'state-value', ...extra });
  async function authorize(memberId, extra = {}) {
    const login = operation('auth.code.create', memberId ? { memberId } : {});
    const params = query({ authorization_code: login.code, ...extra });
    const response = await request('/oauth/authorize', params);
    assert.equal(response.status, 302, response.text);
    const redirect = new URL(response.headers.Location);
    assert.equal(redirect.searchParams.get('state'), params.state);
    assert.equal(redirect.searchParams.get('iss'), issuer);
    return { code: redirect.searchParams.get('code'), login, params };
  }
  const exchange = (code, extra = {}) => request('/oauth/token', { grant_type: 'authorization_code', client_id: clientId,
    resource: issuer + '/mcp', redirect_uri: redirectUri, code_verifier: verifier, code, ...extra });
  const refresh = (token, extra = {}) => request('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, resource: issuer + '/mcp', refresh_token: token, ...extra });
  const principal = token => auth.authenticate({ headers: { authorization: 'Bearer ' + token } });
  const signIn = async (memberId, extra) => (await exchange((await authorize(memberId, extra)).code)).json;
  const loginRecord = code => store.list('auth-code').find(item => item.hash === createHash('sha256').update(code).digest('hex'));
  const reopen = (next = config) => { auth.close(); auth = createAuth({ store, instanceRoot: root, config: next, clientMetadata }); return auth; };
  return { root, store, fetched, get auth() { return auth; }, operation, request, query, authorize, exchange, refresh, principal, signIn, loginRecord, reopen };
}
test('none is the default, returns owner and creates no OAuth key or authorization state', async t => {
  const f = await fixture(t, { config: {} });
  assert.deepEqual(f.auth.authenticate({ headers: {} }), { id: 'owner', role: 'owner', projectIds: null });
  assert.deepEqual(f.auth.check({ headers: {} }), { principal: { id: 'owner', role: 'owner', projectIds: null }, reason: null });
  assert.equal(f.auth.challenge(), null);
  assert.equal(fs.existsSync(path.join(f.root, 'oauth-signing-key')), false);
  assert.equal((await f.request('/oauth/token')).handled, false);
  assert.equal(f.store.list('auth-code').length, 0);
  assert.throws(() => f.operation('auth.code.create'), { code: 'oauth_disabled' });
  assert.throws(() => f.auth.issueVerificationToken(), { code: 'oauth_disabled' });
});
test('OAuth requires an explicit HTTPS origin and has no dynamic registration endpoint', async t => {
  const f = await fixture(t);
  for (const bad of [undefined, 'http://devmate.example', issuer + '/nested', 'https://user:pass@devmate.example', issuer + '?query']) {
    assert.throws(() => createAuth({ store: f.store, instanceRoot: f.root, config: { mode: 'oauth', issuer: bad } }), { code: 'invalid_issuer' });
  }
  assert.equal((await f.request('/oauth/register')).handled, false);
  assert.ok(f.auth.operations.every(op => op.localOnly === true));
  assert.equal(f.auth.authenticate({ headers: {} }), null);
});
test('metadata advertises CIMD, S256, public clients and refresh; the resource lists only its own scope', async t => {
  const f = await fixture(t);
  const server = await f.request('/.well-known/oauth-authorization-server', {}, { method: 'GET' });
  assert.equal(server.json.issuer, issuer); assert.equal(server.json.client_id_metadata_document_supported, true);
  assert.equal(server.json.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(server.json.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(server.json.token_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(server.json.revocation_endpoint_auth_methods_supported, ['none']);
  assert.deepEqual(server.json.grant_types_supported, ['authorization_code', 'refresh_token']);
  // Clients add offline_access when the authorization server lists it.
  assert.deepEqual(server.json.scopes_supported, ['devmate', 'offline_access']);
  assert.equal(server.json.registration_endpoint, undefined);
  assert.equal(server.headers['Access-Control-Allow-Origin'], '*');
  for (const pathname of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    const resource = await f.request(pathname, {}, { method: 'GET' });
    assert.deepEqual(resource.json, { resource: issuer + '/mcp', authorization_servers: [issuer], bearer_methods_supported: ['header'], scopes_supported: ['devmate'] });
  }
  const preflight = await f.request('/oauth/token', {}, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204); assert.match(preflight.headers['Access-Control-Allow-Headers'], /MCP-Protocol-Version/);
});
test('the 401 challenge names the metadata and scope, and says so when a presented token was rejected', async t => {
  const f = await fixture(t), issued = await f.signIn();
  const bearer = token => ({ headers: { authorization: 'Bearer ' + token } });
  assert.deepEqual(f.auth.check({ headers: {} }), { principal: null, reason: null });
  assert.deepEqual(f.auth.check({ headers: { authorization: 'Basic abc' } }), { principal: null, reason: null });
  assert.equal(f.auth.challenge(), 'Bearer resource_metadata="' + issuer + '/.well-known/oauth-protected-resource/mcp", scope="devmate"');
  assert.deepEqual(f.auth.check(bearer(issued.access_token)), { principal: { id: 'owner', role: 'owner', projectIds: null }, reason: null });
  const forged = f.auth.check(bearer(issued.access_token.slice(0, -2) + 'xx'));
  assert.equal(forged.principal, null); assert.match(forged.reason, /invalid or expired/);
  assert.match(f.auth.check({ headers: { authorization: 'Bearer two parts' } }).reason, /malformed/);
  f.operation('auth.grant.revoke', { id: f.store.list('auth-grant')[0].id });
  const revoked = f.auth.check(bearer(issued.access_token));
  assert.equal(revoked.principal, null); assert.match(revoked.reason, /revoked or has expired/);
  assert.equal(f.auth.authenticate(bearer(issued.access_token)), null);
  assert.equal(f.auth.challenge(revoked.reason), 'Bearer error="invalid_token", error_description="' + revoked.reason +
    '", resource_metadata="' + issuer + '/.well-known/oauth-protected-resource/mcp", scope="devmate"');
  assert.equal(f.auth.challenge('quote " slash \\ line\nbreak é').includes('error_description="quote  slash  linebreak "'), true);
});
test('authorization displays exact client and redirect host with S256 and exact redirect binding', async t => {
  const f = await fixture(t);
  const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp', code_challenge: challenge, code_challenge_method: 'S256' };
  const page = await f.request('/oauth/authorize', params, { method: 'GET' });
  assert.equal(page.status, 200); assert.match(page.text, /127\.0\.0\.1:55123/); assert.match(page.text, /Fixture Client/);
  assert.match(page.text, /local application/); assert.equal(page.text.includes(clientId), true);
  for (const change of [{ code_challenge_method: 'plain' }, { code_challenge: 'short' }, { redirect_uri: 'https://attacker.example' }, { resource: 'https://other.example/mcp' }]) {
    assert.equal((await f.request('/oauth/authorize', { ...params, ...change }, { method: 'GET' })).status, 400);
  }
  // One protected resource: naming none means that one, and host case does not matter.
  const { resource, ...unnamed } = params;
  assert.equal((await f.request('/oauth/authorize', unnamed, { method: 'GET' })).status, 200);
  assert.equal((await f.request('/oauth/authorize', { ...params, resource: 'HTTPS://DEVMATE.EXAMPLE/mcp' }, { method: 'GET' })).status, 200);
  assert.equal((await f.request('/oauth/authorize', { ...params, resource: issuer }, { method: 'GET' })).status, 400);
});
test('the authorization page lets its form follow the redirect to the client and nothing else', async t => {
  const f = await fixture(t, { client: { ...metadata, redirect_uris: [redirectUri, 'https://app.example/cb', 'http://[::1]/callback', 'http://localhost/callback'] } });
  const policy = async redirect => (await f.request('/oauth/authorize', f.query({ redirect_uri: redirect }), { method: 'GET' })).headers['Content-Security-Policy'];
  assert.match(await policy(redirectUri), /; form-action 'self' http:\/\/127\.0\.0\.1:55123; /);
  assert.match(await policy('https://app.example/cb'), /; form-action 'self' https:\/\/app\.example; /);
  assert.match(await policy('http://localhost:41234/callback'), /; form-action 'self' http:\/\/localhost:41234; /);
  // CSP has no syntax for an IPv6 host.
  assert.match(await policy('http://[::1]:41234/callback'), /; form-action 'self' http:; /);
  // A page shown again after a wrong code submits the same form, so it carries the same allowance.
  const wrong = await f.request('/oauth/authorize', f.query({ authorization_code: 'wrong' }));
  assert.equal(wrong.status, 403); assert.match(wrong.headers['Content-Security-Policy'], /form-action 'self' http:\/\/127\.0\.0\.1:55123; /);
  const failed = await f.request('/oauth/authorize', f.query({ redirect_uri: 'https://attacker.example/' }), { method: 'GET' });
  assert.match(failed.headers['Content-Security-Policy'], /; form-action 'self'; /);
  for (const page of [wrong, failed]) {
    assert.match(page.headers['Content-Security-Policy'], /^default-src 'none'/); assert.equal(page.headers['X-Frame-Options'], 'DENY');
  }
});
test('authorization errors are readable pages; only a verified redirect is offered as the way back', async t => {
  const f = await fixture(t);
  const get = extra => f.request('/oauth/authorize', f.query(extra), { method: 'GET' });
  const unverified = [await get({ redirect_uri: 'https://attacker.example/callback' }), await get({ client_id: 'http://client.example/metadata.json' }),
    await get({ client_id: 'not a url' }), await f.request('/oauth/authorize', f.query(), { method: 'PUT' })];
  for (const page of unverified) {
    assert.equal(page.status, 400); assert.equal(page.json, undefined);
    assert.match(page.headers['Content-Type'], /^text\/html/); assert.match(page.text, /Sign-in could not continue/);
    assert.equal(page.text.includes('href='), false, 'no link to an unverified redirect');
    assert.equal(page.headers.Location, undefined);
  }
  assert.match(unverified[0].text, /redirect_uri is not one the client declares/);
  assert.match(unverified[0].text, /<code>invalid_request<\/code>/); assert.match(unverified[1].text, /<code>invalid_client<\/code>/);
  const cases = [[{ scope: 'devmate admin' }, 'invalid_scope'], [{ response_type: 'token' }, 'unsupported_response_type'],
    [{ resource: 'https://other.example/mcp' }, 'invalid_target'], [{ code_challenge_method: 'plain' }, 'invalid_request']];
  for (const [change, code] of cases) {
    const page = await get(change);
    assert.equal(page.status, 400); assert.equal(page.headers.Location, undefined, 'never redirected automatically');
    const link = new URL(/href="([^"]+)"/.exec(page.text)[1].replaceAll('&amp;', '&'));
    assert.equal(link.origin + link.pathname, redirectUri);
    assert.equal(link.searchParams.get('error'), code); assert.equal(link.searchParams.get('state'), 'state-value'); assert.equal(link.searchParams.get('iss'), issuer);
    assert.ok(link.searchParams.get('error_description'));
  }
  assert.match((await get({ resource: 'https://other.example/mcp' })).text, /resource must be https:\/\/devmate\.example\/mcp/);
  const hostile = await get({ state: '"><script>alert(1)</script>', scope: 'devmate <b>' });
  assert.equal(hostile.text.includes('<script>'), false); assert.equal(hostile.text.includes('<b>'), false);
  const unknown = await fixture(t, { client: { ...metadata, client_id: 'https://other.example/metadata.json' } });
  const mismatch = await unknown.request('/oauth/authorize', unknown.query(), { method: 'GET' });
  assert.equal(mismatch.status, 400); assert.match(mismatch.text, /does not match its URL/);
});
test('login and authorization codes are each consumed once; wrong PKCE cannot redeem', async t => {
  const f = await fixture(t), authorized = await f.authorize();
  const again = await f.request('/oauth/authorize', authorized.params);
  assert.equal(again.status, 403); assert.match(again.text, /not valid/);
  assert.equal((await f.exchange(authorized.code, { code_verifier: 'x'.repeat(64) })).json.error, 'invalid_grant');
  const result = await f.exchange(authorized.code);
  assert.equal(result.status, 200);
  assert.deepEqual(f.principal(result.json.access_token), { id: 'owner', role: 'owner', projectIds: null });
  assert.equal((await f.exchange(authorized.code)).json.error, 'invalid_grant');
});
test('a replayed authorization code revokes the tokens its first use issued, but a guess does not', async t => {
  const f = await fixture(t), authorized = await f.authorize(), first = (await f.exchange(authorized.code)).json;
  assert.ok(f.principal(first.access_token));
  // Without the PKCE verifier or the right client the request proves nothing and revokes nothing.
  assert.equal((await f.exchange(authorized.code, { code_verifier: 'x'.repeat(64) })).json.error, 'invalid_grant');
  assert.equal((await f.exchange(authorized.code, { client_id: 'https://other.example/client.json' })).json.error, 'invalid_grant');
  assert.ok(f.principal(first.access_token));
  const replay = await f.exchange(authorized.code);
  assert.equal(replay.status, 400); assert.equal(replay.json.error, 'invalid_grant');
  assert.equal(f.principal(first.access_token), null);
  assert.equal((await f.refresh(first.refresh_token)).json.error, 'invalid_grant');
  assert.deepEqual(f.operation('auth.grant.list').items.map(item => [item.status, item.reason]), [['revoked', 'code_replay']]);
});
test('a submission that fails for another reason leaves the one-time code usable', async t => {
  const f = await fixture(t), login = f.operation('auth.code.create');
  const submit = extra => f.request('/oauth/authorize', f.query({ authorization_code: login.code, ...extra }));
  for (const change of [{ redirect_uri: 'https://attacker.example/callback' }, { code_challenge: 'short' }, { resource: 'https://other.example/mcp' },
    { scope: 'devmate admin' }, { response_type: 'token' }, { client_id: 'https://client.example/' }]) {
    assert.equal((await submit(change)).status, 400, JSON.stringify(change));
  }
  assert.equal((await f.request('/oauth/authorize', f.query({ authorization_code: login.code }), { headers: { origin: 'https://attacker.example' } })).status, 400);
  assert.equal(f.loginRecord(login.code).status, 'active');
  assert.equal(f.store.list('auth-code').filter(item => item.purpose === 'authorization').length, 0);
  const wrong = await submit({ authorization_code: login.code + 'x' });
  assert.equal(wrong.status, 403); assert.match(wrong.text, /name="authorization_code"/, 'the form is shown again');
  assert.match(wrong.text, /name="code_challenge" value="/); assert.equal(f.loginRecord(login.code).status, 'active');
  assert.equal((await submit()).status, 302);
  assert.equal(f.loginRecord(login.code).status, 'used');
});
test('wrong one-time codes pause that sign-in; a flood cannot lock the owner out', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t), login = f.operation('auth.code.create', { ttlSeconds: 900 });
  const submit = (code, extra) => f.request('/oauth/authorize', f.query({ authorization_code: code, ...extra }));
  for (let attempt = 1; attempt < REQUEST_ATTEMPTS; attempt++) {
    const wrong = await submit('wrong-' + attempt);
    assert.equal(wrong.status, 403); assert.match(wrong.text, new RegExp((REQUEST_ATTEMPTS - attempt) + ' attempts? left'));
  }
  const last = await submit('wrong-last');
  assert.equal(last.status, 429); assert.equal(last.headers['Retry-After'], String(ATTEMPT_WINDOW_SECONDS)); assert.match(last.text, /Too many incorrect codes\. Wait 60 seconds/);
  // While paused the code is not even looked at, so the right one is refused and stays unused.
  const paused = await submit(login.code);
  assert.equal(paused.status, 429); assert.equal(f.loginRecord(login.code).status, 'active');
  // The pause belongs to this sign-in (client and PKCE challenge); another one is unaffected.
  const other = s256('o'.repeat(64));
  assert.equal((await submit('wrong', { code_challenge: other })).status, 403);
  t.mock.timers.tick(ATTEMPT_WINDOW_SECONDS * 1000);
  assert.equal((await submit(login.code)).status, 302);

  t.mock.timers.tick(ATTEMPT_WINDOW_SECONDS * 1000);
  const second = f.operation('auth.code.create', { ttlSeconds: 900 });
  for (let attempt = 0; attempt < GLOBAL_ATTEMPTS; attempt++) assert.equal((await submit('wrong', { code_challenge: s256('flood-' + attempt + '-'.repeat(40)) })).status, 403);
  const busy = await submit('wrong', { code_challenge: s256('flood-more-' + '-'.repeat(40)) });
  assert.equal(busy.status, 429); assert.match(busy.text, /Too many failed sign-in attempts/); assert.equal(busy.text.includes('<form'), false);
  assert.ok(Number(busy.headers['Retry-After']) > 0);
  assert.equal((await submit(second.code)).status, 302, 'a correct code still signs in during a flood');
  t.mock.timers.tick(ATTEMPT_WINDOW_SECONDS * 1000);
  assert.equal((await submit('wrong', { code_challenge: other })).status, 403, 'the flood window ends');
});
test('authorization codes bind client, redirect and resource without silently changing scopes', async t => {
  const f = await fixture(t), authorized = await f.authorize();
  assert.equal((await f.exchange(authorized.code, { client_id: 'https://other.example/client.json' })).json.error, 'invalid_grant');
  assert.equal((await f.exchange(authorized.code, { redirect_uri: 'http://127.0.0.1:9999/callback' })).json.error, 'invalid_grant');
  const target = await f.exchange(authorized.code, { resource: 'https://other.example/mcp' });
  assert.equal(target.json.error, 'invalid_target'); assert.match(target.json.error_description, /resource must be https:\/\/devmate\.example\/mcp/);
  const result = await f.exchange(authorized.code);
  assert.equal(result.json.scope, 'devmate offline_access'); assert.equal(result.json.token_type, 'Bearer'); assert.equal(result.json.expires_in, ACCESS_TOKEN_SECONDS);
  // OAuth 2.1 token requests carry neither redirect_uri nor, for some clients, resource.
  const { code } = await f.authorize();
  const minimal = await f.request('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code_verifier: verifier, code });
  assert.equal(minimal.status, 200, minimal.text); assert.ok(f.principal(minimal.json.access_token));
});
test('clients are public: a secret, an assertion or HTTP authentication is refused', async t => {
  const f = await fixture(t), issued = await f.signIn(), { code } = await f.authorize();
  for (const extra of [{ client_secret: 'secret' }, { client_assertion: 'jwt', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' }]) {
    const refused = await f.exchange(code, extra);
    assert.equal(refused.status, 400); assert.equal(refused.json.error, 'invalid_client'); assert.match(refused.json.error_description, /public clients only/);
    assert.equal((await f.refresh(issued.refresh_token, extra)).json.error, 'invalid_client');
  }
  const basic = await f.request('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, code_verifier: verifier, code }, { headers: { authorization: 'Basic Y2xpZW50OnNlY3JldA==' } });
  assert.equal(basic.status, 401); assert.equal(basic.json.error, 'invalid_client'); assert.match(basic.headers['WWW-Authenticate'], /^Basic /);
  for (const bad of [{ client_id: '' }, { client_id: 'plain-id' }, { client_id: 'https://client.example/a/../metadata.json' }]) assert.equal((await f.exchange(code, bad)).json.error, 'invalid_client');
  // None of these touched the code or the refresh token.
  assert.equal((await f.exchange(code)).status, 200);
  assert.equal((await f.refresh(issued.refresh_token)).status, 200);
  assert.equal((await f.request('/oauth/token', { grant_type: 'password', client_id: clientId })).json.error, 'unsupported_grant_type');
});
test('member principal preserves explicit read/write role and project scope', async t => {
  const f = await fixture(t);
  const project = f.store.create('project', { root: f.root, access: 'write', name: 'Fixture' });
  const member = f.operation('auth.member.create', { name: 'Friend', role: 'read', projectIds: [project.id, project.id] });
  const result = await f.exchange((await f.authorize(member.id)).code);
  assert.deepEqual(f.principal(result.json.access_token), { id: member.id, role: 'read', projectIds: [project.id], authVersion: 1 });
  assert.throws(() => f.operation('auth.member.create', { name: 'Escalate', role: 'owner', projectIds: [] }));
  assert.throws(() => f.operation('auth.member.create', { name: 'Other', role: 'write', projectIds: ['missing'] }), { code: 'not_found' });
});
test('a refresh token follows the client grant types, not the offline_access scope', async t => {
  const f = await fixture(t), plain = await f.signIn(undefined, { scope: 'devmate' });
  assert.equal(plain.scope, 'devmate'); assert.ok(plain.refresh_token, 'the client declares the refresh_token grant');
  const next = await f.refresh(plain.refresh_token);
  assert.equal(next.status, 200); assert.equal(next.json.scope, 'devmate'); assert.ok(f.principal(next.json.access_token));
  const { scope, ...unscoped } = f.query();
  const login = f.operation('auth.code.create');
  const implicit = await f.request('/oauth/authorize', { ...unscoped, authorization_code: login.code });
  assert.equal((await f.exchange(new URL(implicit.headers.Location).searchParams.get('code'))).json.scope, 'devmate');

  const codeOnly = await fixture(t, { client: { ...metadata, grant_types: ['authorization_code'] } });
  const short = await codeOnly.signIn(undefined, { scope: 'devmate' });
  assert.equal(short.refresh_token, undefined);
  assert.equal(codeOnly.store.list('auth-grant')[0].expiresAt - seconds() <= ACCESS_TOKEN_SECONDS, true);
  assert.ok((await codeOnly.signIn()).refresh_token, 'asking for offline_access is honoured as well');
  const undeclared = await fixture(t, { client: { client_id: clientId, client_name: 'Minimal', redirect_uris: [redirectUri] } });
  assert.equal((await undeclared.signIn(undefined, { scope: 'devmate' })).refresh_token, undefined);
});
test('each refresh extends the grant by the idle period, never past its absolute age', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const f = await fixture(t), start = seconds(), day = 86400;
  let current = await f.signIn(undefined, { scope: 'devmate' });
  const grant = () => f.store.list('auth-grant')[0];
  assert.equal(grant().expiresAt, start + GRANT_IDLE_SECONDS); assert.equal(grant().maxExpiresAt, start + GRANT_MAX_SECONDS);
  const step = GRANT_IDLE_SECONDS - day;
  for (let elapsed = step; elapsed < GRANT_MAX_SECONDS; elapsed += step) {
    t.mock.timers.tick(step * 1000);
    assert.equal(f.principal(current.access_token), null, 'the access token itself is short-lived');
    const refreshed = await f.refresh(current.refresh_token);
    assert.equal(refreshed.status, 200, 'day ' + elapsed / day + ': ' + refreshed.text);
    assert.equal(grant().expiresAt, Math.min(start + elapsed + GRANT_IDLE_SECONDS, start + GRANT_MAX_SECONDS));
    assert.equal(refreshed.json.expires_in, Math.min(ACCESS_TOKEN_SECONDS, grant().expiresAt - seconds()));
    assert.ok(f.principal(refreshed.json.access_token));
    current = refreshed.json;
  }
  assert.equal(grant().expiresAt, start + GRANT_MAX_SECONDS, 'the last refresh could only reach the absolute limit');
  t.mock.timers.tick((grant().expiresAt - seconds()) * 1000);
  assert.equal((await f.refresh(current.refresh_token)).json.error, 'invalid_grant');
  assert.equal(f.operation('auth.grant.list').items[0].status, 'expired');

  const idle = await fixture(t), unused = await idle.signIn();
  t.mock.timers.tick((GRANT_IDLE_SECONDS + 1) * 1000);
  assert.equal((await idle.refresh(unused.refresh_token)).json.error, 'invalid_grant', 'an unused grant ends after the idle period');
});
test('refresh rotation rejects replay and revokes the whole family including access tokens', async t => {
  const f = await fixture(t), first = (await f.exchange((await f.authorize()).code)).json;
  const second = await f.refresh(first.refresh_token);
  assert.equal(second.status, 200); assert.notEqual(second.json.refresh_token, first.refresh_token);
  assert.ok(f.principal(second.json.access_token));
  assert.equal((await f.refresh(first.refresh_token)).json.error, 'invalid_grant');
  assert.equal(f.principal(first.access_token), null);
  assert.equal(f.principal(second.json.access_token), null);
  assert.equal((await f.refresh(second.json.refresh_token)).json.error, 'invalid_grant');
  assert.deepEqual(f.operation('auth.grant.list').items.map(item => [item.status, item.reason]), [['revoked', 'refresh_reuse']]);
});
test('a refresh token presented by another client revokes the family', async t => {
  const f = await fixture(t), first = await f.signIn();
  const wrong = await f.refresh(first.refresh_token, { client_id: 'https://other.example/client.json' });
  assert.equal(wrong.status, 400); assert.equal(wrong.json.error, 'invalid_grant');
  assert.equal(f.principal(first.access_token), null);
  assert.equal((await f.refresh(first.refresh_token)).json.error, 'invalid_grant');
  assert.deepEqual(f.operation('auth.grant.list').items.map(item => [item.status, item.reason]), [['revoked', 'refresh_binding_mismatch']]);
});
test('a refresh may omit resource and scope; a wrong value is refused without ending the grant', async t => {
  const f = await fixture(t), first = await f.signIn(undefined, { scope: 'devmate' });
  const target = await f.refresh(first.refresh_token, { resource: 'https://other.example/mcp' });
  assert.equal(target.json.error, 'invalid_target'); assert.match(target.json.error_description, /resource must be https:\/\/devmate\.example\/mcp \(or be omitted\)/);
  const widened = await f.refresh(first.refresh_token, { scope: 'devmate offline_access' });
  assert.equal(widened.json.error, 'invalid_scope');
  assert.equal((await f.request('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: 'not-a-token' })).json.error, 'invalid_grant');
  assert.ok(f.principal(first.access_token), 'none of these revoked the grant');
  const bare = await f.request('/oauth/token', { grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token });
  assert.equal(bare.status, 200, bare.text);
  assert.equal((await f.refresh(bare.json.refresh_token, { scope: 'devmate' })).status, 200);
});
test('disable and scope change immediately invalidate issued tokens and unused login codes', async t => {
  const f = await fixture(t);
  const member = f.operation('auth.member.create', { name: 'Friend', role: 'write', projectIds: [] });
  const pending = f.operation('auth.code.create', { memberId: member.id });
  const tokens = (await f.exchange((await f.authorize(member.id)).code)).json;
  f.operation('auth.member.update', { id: member.id, disabled: true, expectedRevision: member.revision });
  assert.equal(f.principal(tokens.access_token), null);
  assert.equal((await f.refresh(tokens.refresh_token)).json.error, 'invalid_grant');
  assert.throws(() => f.operation('auth.code.create', { memberId: member.id }), { code: 'identity_disabled' });
  f.operation('auth.member.update', { id: member.id, disabled: false, role: 'read' });
  const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp',
    code_challenge: challenge, code_challenge_method: 'S256', authorization_code: pending.code };
  assert.equal((await f.request('/oauth/authorize', params)).status, 403);
  const fresh = (await f.exchange((await f.authorize(member.id)).code)).json;
  assert.equal(f.principal(fresh.access_token).role, 'read');
});
test('credentials and token strings are never persisted in SQLite entities or events', async t => {
  const f = await fixture(t), authorized = await f.authorize(), issued = (await f.exchange(authorized.code)).json;
  const verification = f.auth.issueVerificationToken();
  const persisted = JSON.stringify({
    entities: f.store.db.prepare('SELECT data FROM entities').all(),
    events: f.store.db.prepare('SELECT data FROM events').all()
  });
  for (const value of [authorized.login.code, authorized.code, issued.access_token, issued.refresh_token, verification.accessToken]) assert.equal(persisted.includes(value), false);
  const listed = JSON.stringify(f.operation('auth.grant.list'));
  assert.equal(listed.includes('refreshHash'), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'oauth-signing-key'), 'utf8').length, 64);
});
test('new factory instance preserves token verification and one-time code consumption', async t => {
  const f = await fixture(t), authorized = await f.authorize(), issued = (await f.exchange(authorized.code)).json;
  f.reopen();
  assert.ok(f.principal(issued.access_token));
  assert.equal((await f.refresh(issued.refresh_token)).status, 200);
  const other = await f.authorize();
  f.reopen();
  assert.equal((await f.exchange(other.code)).status, 200);
  assert.equal((await f.request('/oauth/authorize', other.params)).status, 403);
});
test('revocation follows RFC 7009 and member removal invalidates grants', async t => {
  const f = await fixture(t);
  const member = f.operation('auth.member.create', { name: 'Friend', role: 'write', projectIds: [] });
  const issued = (await f.exchange((await f.authorize(member.id)).code)).json;
  // A token another client holds is left alone, and an unknown token is not an error.
  assert.equal((await f.request('/oauth/revoke', { client_id: 'https://other.example/client.json', token: issued.refresh_token })).status, 200);
  assert.equal((await f.request('/oauth/revoke', { client_id: clientId, token: 'unknown' })).status, 200);
  assert.ok(f.principal(issued.access_token));
  assert.equal((await f.request('/oauth/revoke', { client_id: clientId })).json.error, 'invalid_request');
  assert.equal((await f.request('/oauth/revoke', { token: issued.refresh_token })).json.error, 'invalid_client');
  const revoke = await f.request('/oauth/revoke', { client_id: clientId, token: issued.refresh_token, token_type_hint: 'refresh_token' });
  assert.equal(revoke.status, 200); assert.deepEqual(revoke.json, {}); assert.equal(f.principal(issued.access_token), null);
  assert.equal((await f.refresh(issued.refresh_token)).json.error, 'invalid_grant');
  const byAccess = (await f.exchange((await f.authorize(member.id)).code)).json;
  assert.equal((await f.request('/oauth/revoke', { client_id: clientId, token: byAccess.access_token, resource: issuer + '/mcp' })).status, 200);
  assert.equal(f.principal(byAccess.access_token), null);
  assert.equal((await f.refresh(byAccess.refresh_token)).json.error, 'invalid_grant');
  const next = (await f.exchange((await f.authorize(member.id)).code)).json;
  f.operation('auth.member.remove', { id: member.id });
  assert.equal(f.principal(next.access_token), null);
});
test('authorization POST rejects foreign Origin and ambiguous duplicate parameters', async t => {
  const f = await fixture(t);
  const login = f.operation('auth.code.create');
  const params = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp',
    code_challenge: challenge, code_challenge_method: 'S256', authorization_code: login.code };
  assert.equal((await f.request('/oauth/authorize', params, { headers: { origin: 'https://attacker.example' } })).status, 400);
  const url = '/oauth/authorize?client_id=' + encodeURIComponent(clientId) + '&client_id=' + encodeURIComponent(clientId);
  const req = Readable.from([]); req.method = 'GET'; req.headers = {};
  const res = { writeHead(status) { this.status = status; }, end() {} };
  assert.equal(await f.auth.handle(req, res, new URL(url, issuer)), true);
  assert.equal(res.status, 400);
  // The page is served with no-referrer, so a browser posts its form with "Origin: null"
  // and says through Sec-Fetch-Site whether the form was ours.
  for (const headers of [{ origin: 'null', 'sec-fetch-site': 'cross-site' }, { origin: 'null', 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'cross-site' },
    { origin: issuer, 'sec-fetch-site': 'cross-site' }, { origin: 'https://attacker.example', 'sec-fetch-site': 'same-origin' }, { origin: issuer + '.attacker.example' }]) {
    const refused = await f.request('/oauth/authorize', params, { headers });
    assert.equal(refused.status, 400, JSON.stringify(headers)); assert.match(refused.text, /submitted from another site/);
  }
  assert.equal(f.loginRecord(login.code).status, 'active');
  assert.equal((await f.request('/oauth/authorize', params, { headers: { origin: 'null', 'sec-fetch-site': 'same-origin' } })).status, 302);
  for (const headers of [{ origin: issuer, 'sec-fetch-site': 'same-origin' }, { origin: issuer }, { origin: 'null' }])
    assert.equal((await f.request('/oauth/authorize', { ...params, authorization_code: f.operation('auth.code.create').code }, { headers })).status, 302, JSON.stringify(headers));
});

test('concurrent exchange consumes one authorization code atomically', async t => {
  const f = await fixture(t), authorized = await f.authorize();
  const results = await Promise.all([f.exchange(authorized.code), f.exchange(authorized.code)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 400]);
  assert.equal(f.store.list('auth-grant').length, 1);
});
test('expired login, authorization and grant state fail closed', async t => {
  const f = await fixture(t), authorized = await f.authorize();
  const login = f.operation('auth.code.create');
  f.store.update('auth-code', f.loginRecord(login.code).id, { expiresAt: seconds() - 1 });
  assert.equal((await f.request('/oauth/authorize', { ...authorized.params, authorization_code: login.code })).status, 403);
  const code = f.store.list('auth-code').find(item => item.purpose === 'authorization');
  f.store.update('auth-code', code.id, { expiresAt: seconds() - 1 });
  assert.equal((await f.exchange(authorized.code)).json.error, 'invalid_grant');
  const issued = (await f.exchange((await f.authorize()).code)).json;
  const grant = f.store.list('auth-grant')[0];
  f.store.update('auth-grant', grant.id, { expiresAt: seconds() - 1 });
  assert.equal(f.principal(issued.access_token), null);
  assert.equal((await f.refresh(issued.refresh_token)).json.error, 'invalid_grant');
});
test('nothing depends on used codes or ended grants still being stored', async t => {
  const f = await fixture(t), authorized = await f.authorize(), issued = (await f.exchange(authorized.code)).json;
  const second = await f.signIn();
  // What the store prunes by age: used codes, then the grants themselves.
  f.store.db.prepare("DELETE FROM entities WHERE kind='auth-code'").run();
  assert.equal((await f.exchange(authorized.code)).json.error, 'invalid_grant');
  assert.equal((await f.request('/oauth/authorize', authorized.params)).status, 403);
  assert.ok(f.principal(issued.access_token), 'a replay of a pruned code can no longer be tied to a grant');
  assert.equal((await f.refresh(issued.refresh_token)).status, 200);
  f.store.db.prepare("DELETE FROM entities WHERE kind='auth-grant'").run();
  assert.equal(f.principal(second.access_token), null);
  assert.match(f.auth.check({ headers: { authorization: 'Bearer ' + second.access_token } }).reason, /revoked or has expired/);
  assert.equal((await f.refresh(second.refresh_token)).json.error, 'invalid_grant');
  assert.equal((await f.request('/oauth/revoke', { client_id: clientId, token: second.refresh_token })).status, 200);
  assert.deepEqual(f.operation('auth.grant.list'), { items: [] });
  assert.throws(() => f.operation('auth.grant.revoke', { id: 'auth-grant-missing' }), { code: 'not_found' });
});
test('grant list is bounded and newest first; revoking a member reaches every one of its grants', async t => {
  const f = await fixture(t);
  const member = f.operation('auth.member.create', { name: 'Friend', role: 'write', projectIds: [] });
  const base = { purpose: 'client', authVersion: 1, clientId, scope: 'devmate', status: 'active', generation: 1, refreshable: false, refreshHash: 'h' };
  const ids = [];
  f.store.transaction(() => { for (let index = 0; index < 620; index++) ids.push(f.store.create('auth-grant', { ...base, subject: index % 2 ? member.id : 'owner', expiresAt: seconds() + 600, maxExpiresAt: seconds() + 600 }).id); });
  const listed = f.operation('auth.grant.list').items;
  assert.equal(listed.length, 100);
  assert.deepEqual(listed.map(item => item.id), ids.slice(-100).reverse());
  assert.deepEqual(Object.keys(listed[0]).sort(), ['clientId', 'createdAt', 'expiresAt', 'id', 'purpose', 'scope', 'status', 'subject', 'updatedAt']);
  assert.equal(f.operation('auth.grant.list', { limit: 500 }).items.length, 500);
  assert.equal(f.operation('auth.grant.list', { limit: 3 }).items.length, 3);
  assert.throws(() => f.operation('auth.grant.list', { limit: 501 }));
  f.operation('auth.member.update', { id: member.id, role: 'read' });
  const after = f.store.list('auth-grant', { limit: 10000 });
  assert.equal(after.filter(item => item.subject === member.id && item.status === 'revoked' && item.reason === 'identity_changed').length, 310);
  assert.equal(after.filter(item => item.subject === 'owner' && item.status === 'active').length, 310);
});
test('a verification token is a short grant without refresh and without access to any project, listed and then removed', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const f = await fixture(t), start = seconds();
  const issued = f.auth.issueVerificationToken({ ttlSeconds: 30 });
  assert.deepEqual(Object.keys(issued).sort(), ['accessToken', 'expiresAt', 'grantId']);
  assert.equal(issued.expiresAt, new Date((start + 30) * 1000).toISOString());
  // It is sent to whatever answers at the public address, so it can ask which runtime that is and nothing more.
  assert.deepEqual(f.principal(issued.accessToken), { id: 'verification', role: 'read', projectIds: [] });
  const [listed] = f.operation('auth.grant.list').items;
  assert.deepEqual({ id: listed.id, purpose: listed.purpose, subject: listed.subject, scope: listed.scope, status: listed.status, clientId: listed.clientId, expiresAt: listed.expiresAt },
    { id: issued.grantId, purpose: 'verification', subject: 'devmate:verification', scope: 'devmate', status: 'active', clientId: 'devmate:route-verification', expiresAt: start + 30 });
  const stored = f.store.get('auth-grant', issued.grantId);
  assert.equal(stored.refreshable, false); assert.equal(stored.refreshHash, null);
  // The longest lifetime is fixed here, whatever the caller asks for.
  const long = f.auth.issueVerificationToken({ ttlSeconds: 3600 });
  assert.equal(f.store.get('auth-grant', long.grantId).expiresAt, start + VERIFICATION_MAX_SECONDS);
  assert.equal(f.store.get('auth-grant', f.auth.issueVerificationToken().grantId).expiresAt, start + 60);
  const client = await f.signIn();
  t.mock.timers.tick(31 * 1000);
  assert.equal(f.principal(issued.accessToken), null);
  assert.deepEqual(f.store.list('auth-grant').map(item => item.purpose).sort(), ['client', 'verification', 'verification'], 'the expired one was removed by its timer');
  t.mock.timers.tick(VERIFICATION_MAX_SECONDS * 1000);
  assert.deepEqual(f.store.list('auth-grant').map(item => item.purpose), ['client']);
  assert.ok((await f.refresh(client.refresh_token)).json.access_token, 'client grants are untouched');
  // One left behind by a stopped runtime is removed by the next start and by the next issue.
  const leftover = f.auth.issueVerificationToken({ ttlSeconds: 10 });
  f.auth.close();
  t.mock.timers.tick(60 * 1000);
  assert.ok(f.store.get('auth-grant', leftover.grantId));
  f.reopen();
  assert.deepEqual(f.store.list('auth-grant').map(item => item.purpose), ['client']);
});
test('an internal failure is reported as a server error, not as a rejected grant', async t => {
  const f = await fixture(t), issued = await f.signIn(), login = f.operation('auth.code.create');
  const transaction = f.store.transaction;
  f.store.transaction = () => { throw new Error('database is locked'); };
  const failed = await f.refresh(issued.refresh_token);
  assert.equal(failed.status, 500); assert.equal(failed.json.error, 'server_error'); assert.equal(failed.text.includes('database is locked'), false);
  const page = await f.request('/oauth/authorize', f.query({ authorization_code: login.code }));
  assert.equal(page.status, 500); assert.match(page.text, /could not complete this sign-in/); assert.equal(page.text.includes('database is locked'), false);
  f.store.transaction = transaction;
  assert.equal((await f.refresh(issued.refresh_token)).status, 200, 'the client can simply retry');
});
test('state and signing key survive closing and reopening SQLite', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-auth-restart-'));
  let store = new Store(root);
  let auth = createAuth({store,instanceRoot:root,config:{mode:'oauth',issuer},clientMetadata:async()=>metadata});
  const before = auth.operations.find(op=>op.name==='auth.code.create').run({});
  const stored = store.list('auth-code')[0];
  const originalKey = fs.readFileSync(path.join(root,'oauth-signing-key'),'utf8');
  auth.close(); store.close();
  store = new Store(root);
  auth = createAuth({store,instanceRoot:root,config:{mode:'oauth',issuer},clientMetadata:async()=>metadata});
  t.after(()=>{auth.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(store.get('auth-code',stored.id).hash,createHash('sha256').update(before.code).digest('hex'));
  assert.equal(store.get('auth-code',stored.id).status,'active');
  assert.equal(fs.readFileSync(path.join(root,'oauth-signing-key'),'utf8'),originalKey);
});

// Clients the owner registers in the configuration because they publish no metadata document.
const registered = { clientId: 'gemini-cli', name: 'Gemini CLI', redirectUris: ['http://127.0.0.1/oauth/callback', 'https://example.com/cb'] };
const registeredRedirect = 'http://127.0.0.1:49152/oauth/callback';
const asRegistered = { client_id: registered.clientId, redirect_uri: registeredRedirect };
const withClients = (...clients) => ({ config: { mode: 'oauth', issuer, clients: clients.length ? clients : [registered] } });
test('a registered client signs in without a metadata document: PKCE, tokens, rotation and revocation as for any client', async t => {
  const f = await fixture(t, withClients());
  const page = await f.request('/oauth/authorize', f.query(asRegistered), { method: 'GET' });
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /<strong>Gemini CLI<\/strong> asks to use DevMate/); assert.match(page.text, /Client: <code>gemini-cli<\/code>/);
  assert.match(page.text, /The owner of this DevMate registered this client/, 'the page says whose word the name is');
  assert.match(page.text, /<strong>127\.0\.0\.1:49152<\/strong>/); assert.match(page.text, /local application/);
  const issued = await f.exchange((await f.authorize(undefined, asRegistered)).code, asRegistered);
  assert.equal(issued.status, 200, issued.text);
  assert.equal(issued.json.token_type, 'Bearer'); assert.equal(issued.json.scope, 'devmate offline_access'); assert.equal(issued.json.expires_in, ACCESS_TOKEN_SECONDS);
  assert.deepEqual(f.principal(issued.json.access_token), { id: 'owner', role: 'owner', projectIds: null });
  const refresh = token => f.refresh(token, { client_id: registered.clientId });
  const second = await refresh(issued.json.refresh_token);
  assert.equal(second.status, 200, second.text); assert.notEqual(second.json.refresh_token, issued.json.refresh_token); assert.ok(f.principal(second.json.access_token));
  assert.equal((await refresh(issued.json.refresh_token)).json.error, 'invalid_grant', 'a used refresh token ends the family');
  assert.equal(f.principal(second.json.access_token), null);
  assert.deepEqual(f.operation('auth.grant.list').items.map(item => [item.clientId, item.status, item.reason]), [['gemini-cli', 'revoked', 'refresh_reuse']]);
  // Revocation is the client's own: the token is revoked for the client it was issued to.
  const again = (await f.exchange((await f.authorize(undefined, asRegistered)).code, asRegistered)).json;
  assert.equal((await f.request('/oauth/revoke', { client_id: clientId, token: again.refresh_token })).status, 200);
  assert.ok(f.principal(again.access_token));
  assert.equal((await f.request('/oauth/revoke', { client_id: registered.clientId, token: again.refresh_token })).status, 200);
  assert.equal(f.principal(again.access_token), null); assert.equal((await refresh(again.refresh_token)).json.error, 'invalid_grant');
  // The owner registered it, so it stays signed in also when it does not ask for offline_access.
  const plain = (await f.exchange((await f.authorize(undefined, { ...asRegistered, scope: 'devmate' })).code, asRegistered)).json;
  assert.equal(plain.scope, 'devmate'); assert.ok(plain.refresh_token); assert.ok(f.principal(plain.access_token));
  // Identities and their grants are the same whichever kind of client signs in.
  const member = f.operation('auth.member.create', { name: 'Friend', role: 'read', projectIds: [] });
  const friend = (await f.exchange((await f.authorize(member.id, asRegistered)).code, asRegistered)).json;
  assert.deepEqual(f.principal(friend.access_token), { id: member.id, role: 'read', projectIds: [], authVersion: 1 });
  assert.deepEqual(f.fetched, [], 'nothing was fetched for a registered client');
});
test('a client taken out of the configuration can no longer sign in, redeem a code or refresh', async t => {
  const f = await fixture(t, withClients());
  const issued = (await f.exchange((await f.authorize(undefined, asRegistered)).code, asRegistered)).json, pending = await f.authorize(undefined, asRegistered);
  f.reopen({ mode: 'oauth', issuer });
  assert.equal((await f.request('/oauth/authorize', f.query(asRegistered), { method: 'GET' })).status, 400);
  assert.equal((await f.exchange(pending.code, asRegistered)).json.error, 'invalid_client');
  assert.equal((await f.refresh(issued.refresh_token, { client_id: registered.clientId })).json.error, 'invalid_client');
  // The access token it already holds lasts until it runs out or the owner revokes the grant.
  assert.ok(f.principal(issued.access_token));
  f.operation('auth.grant.revoke', { id: f.store.list('auth-grant')[0].id });
  assert.equal(f.principal(issued.access_token), null);
  assert.deepEqual(f.fetched, []);
});
test('a registered client is refused without PKCE, at a redirect that is not registered and under a name that is not; nothing is issued', async t => {
  const f = await fixture(t, withClients()), login = f.operation('auth.code.create');
  const { code_challenge, code_challenge_method, ...withoutPkce } = f.query(asRegistered);
  // Each is tried as the page request and as the form post that carries a valid one-time code.
  const attempt = async params => [await f.request('/oauth/authorize', params, { method: 'GET' }), await f.request('/oauth/authorize', { ...params, authorization_code: login.code })];
  for (const params of [withoutPkce, { ...withoutPkce, code_challenge }, { ...withoutPkce, code_challenge, code_challenge_method: 'plain' }, { ...withoutPkce, code_challenge: verifier, code_challenge_method }]) {
    for (const page of await attempt(params)) {
      assert.equal(page.status, 400, JSON.stringify(params)); assert.equal(page.headers.Location, undefined);
      assert.match(page.text, /<code>invalid_request<\/code>/); assert.match(page.text, /A valid PKCE S256 challenge is required/);
      // The redirect is a registered one, so the client may be told.
      const link = new URL(/href="([^"]+)"/.exec(page.text)[1].replaceAll('&amp;', '&'));
      assert.equal(link.origin + link.pathname, registeredRedirect); assert.equal(link.searchParams.get('error'), 'invalid_request'); assert.equal(link.searchParams.get('code'), null);
    }
  }
  for (const redirect of ['https://example.com/other', 'https://attacker.example/cb', 'http://example.com/cb', 'http://192.168.1.10/oauth/callback', 'http://127.0.0.1:49152/oauth/callback#fragment', '/oauth/callback', '']) {
    for (const page of await attempt(f.query({ ...asRegistered, redirect_uri: redirect }))) {
      assert.equal(page.status, 400, redirect); assert.equal(page.headers.Location, undefined); assert.equal(page.text.includes('href='), false, 'no link to a redirect that is not registered');
      assert.match(page.text, /<code>invalid_request<\/code>/); assert.match(page.text, /redirect_uri is not one registered for this client/);
    }
  }
  for (const name of ['my-desktop-client', 'Gemini-CLI', 'gemini-cli ', 'gemini-cli/', 'urn:gemini-cli', '']) {
    for (const page of await attempt(f.query({ ...asRegistered, client_id: name }))) {
      assert.equal(page.status, 400, name); assert.equal(page.headers.Location, undefined); assert.equal(page.text.includes('href='), false);
      assert.match(page.text, /<code>invalid_client<\/code>/);
    }
  }
  assert.match((await attempt(f.query({ ...asRegistered, client_id: 'my-desktop-client' })))[0].text, /or a client registered in the configuration of this DevMate/);
  assert.equal(f.loginRecord(login.code).status, 'active', 'no refusal spent the one-time code');
  assert.equal(f.store.list('auth-code').filter(item => item.purpose === 'authorization').length, 0);
  assert.deepEqual(f.fetched, [], 'a name that is not a URL is never looked up');

  // At the token endpoint the code answers only to its own client, its redirect and its PKCE verifier.
  const { code } = await f.authorize(undefined, asRegistered);
  for (const wrong of [{ code_verifier: 'x'.repeat(64) }, { code_verifier: challenge }, { code_verifier: '' }, { redirect_uri: 'http://127.0.0.1:49153/oauth/callback' }, { client_id: clientId }])
    assert.equal((await f.exchange(code, { ...asRegistered, ...wrong })).json.error, 'invalid_grant', JSON.stringify(wrong));
  assert.equal((await f.request('/oauth/token', { grant_type: 'authorization_code', client_id: registered.clientId, code })).json.error, 'invalid_grant', 'no verifier at all');
  for (const wrong of [{ client_id: 'my-desktop-client' }, { client_id: 'Gemini-CLI' }, { client_secret: 'secret' }]) {
    const refused = await f.exchange(code, { ...asRegistered, ...wrong });
    assert.equal(refused.status, 400, JSON.stringify(wrong)); assert.equal(refused.json.error, 'invalid_client');
  }
  const basic = await f.request('/oauth/token', { grant_type: 'authorization_code', client_id: registered.clientId, code_verifier: verifier, code }, { headers: { authorization: 'Basic Z2VtaW5pLWNsaTpzZWNyZXQ=' } });
  assert.equal(basic.status, 401); assert.equal(basic.json.error, 'invalid_client');
  // A code issued to a client that publishes a document is not this client's to redeem either.
  assert.equal((await f.exchange((await f.authorize()).code, { client_id: registered.clientId })).json.error, 'invalid_grant');
  assert.equal(f.store.list('auth-grant').length, 0, 'nothing was issued');
  assert.equal((await f.exchange(code, asRegistered)).status, 200, 'and none of it spent the code');
});
test('a registered loopback redirect may arrive on any port, never at another path or host; an https redirect is exact', async t => {
  const f = await fixture(t, withClients({ ...registered, redirectUris: ['http://127.0.0.1/oauth/callback', 'http://localhost:7777/oauth/callback', 'http://[::1]/v6', 'https://example.com/cb'] }));
  const page = redirect => f.request('/oauth/authorize', f.query({ ...asRegistered, redirect_uri: redirect }), { method: 'GET' });
  for (const accepted of ['http://127.0.0.1/oauth/callback', registeredRedirect, 'http://127.0.0.1:1/oauth/callback', 'http://localhost:7777/oauth/callback', 'http://localhost:51000/oauth/callback',
    'http://localhost/oauth/callback', 'http://[::1]:5000/v6', 'https://example.com/cb'])
    assert.equal((await page(accepted)).status, 200, accepted);
  for (const refused of ['http://127.0.0.1:49152/oauth/other', 'http://127.0.0.1:49152/oauth/callback/', 'http://127.0.0.1:49152/', 'http://127.0.0.1:49152/oauth/callback?x=1', 'http://127.0.0.1:49152/v6',
    'http://127.0.0.2:49152/oauth/callback', 'http://user@127.0.0.1:49152/oauth/callback', 'https://127.0.0.1:49152/oauth/callback', 'http://[::1]:5000/oauth/callback',
    'http://localhost.attacker.example:7777/oauth/callback', 'http://0.0.0.0:49152/oauth/callback',
    // Only a loopback redirect has the port exception.
    'https://example.com:8443/cb', 'https://example.com/cb/', 'https://example.com/cb?x=1', 'https://EXAMPLE.com/cb', 'http://example.com/cb', 'https://example.com.attacker.example/cb'])
    assert.equal((await page(refused)).status, 400, refused);
  assert.match((await page(registeredRedirect)).headers['Content-Security-Policy'], /; form-action 'self' http:\/\/127\.0\.0\.1:49152; /);
  // The sign-in returns to the port the client chose, and its code stays bound to that redirect.
  const authorized = await f.request('/oauth/authorize', f.query({ ...asRegistered, authorization_code: f.operation('auth.code.create').code }));
  assert.equal(authorized.status, 302, authorized.text);
  const location = new URL(authorized.headers.Location);
  assert.equal(location.origin + location.pathname, registeredRedirect); assert.equal(location.searchParams.get('iss'), issuer); assert.equal(location.searchParams.get('state'), 'state-value');
  const code = location.searchParams.get('code');
  assert.equal((await f.exchange(code, { ...asRegistered, redirect_uri: 'http://127.0.0.1:49153/oauth/callback' })).json.error, 'invalid_grant');
  assert.equal((await f.exchange(code, asRegistered)).status, 200);
});
test('the configuration accepts registered clients and says what is wrong with one it refuses', async t => {
  const settings = clients => ({ auth: { mode: 'oauth', issuer, clients } });
  assert.deepEqual(normalizeConfig(settings([registered])).auth, { mode: 'oauth', issuer, clients: [registered] });
  // Nothing is added for an owner who registers none.
  assert.deepEqual(normalizeConfig({}).auth, { mode: 'none' });
  assert.deepEqual(normalizeConfig({ auth: { mode: 'oauth', issuer } }).auth, { mode: 'oauth', issuer });
  const uris = count => Array.from({ length: count }, (_, index) => 'https://example.com/cb/' + index);
  for (const fine of [{ ...registered, clientId: 'G' + 'x'.repeat(199) }, { ...registered, clientId: '2nd.Gemini_CLI-beta' }, { ...registered, name: 'n'.repeat(100) }, { ...registered, redirectUris: uris(10) },
    { ...registered, redirectUris: ['http://localhost:7777/oauth/callback', 'http://[::1]/cb', 'https://example.com/cb?fixed=1'] }])
    assert.deepEqual(normalizeConfig(settings([fine])).auth.clients, [fine]);
  assert.equal(normalizeConfig(settings([{ ...registered, name: '  Gemini CLI ' }])).auth.clients[0].name, 'Gemini CLI');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-auth-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // What the owner reads when the saved file is refused.
  const refusal = clients => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(settings(clients)));
    try { readConfig(root); } catch (error) { assert.equal(error.code, 'invalid_config', error.message); return error.message; }
    assert.fail('accepted ' + JSON.stringify(clients));
  };
  assert.match(refusal([{ ...registered, clientId }]), /auth\.clients\.0\.clientId: Use a plain name of at most 200 letters, digits, "\.", "_" or "-".* A URL is not a name/);
  assert.match(refusal([registered, { ...registered, name: 'Listed twice' }]), /auth\.clients: Each clientId may be listed once\./);
  assert.match(refusal([{ ...registered, redirectUris: [] }]), /auth\.clients\.0\.redirectUris: List at least one redirect URI\./);
  assert.match(refusal([registered, { ...registered, clientId: 'other', redirectUris: ['https://example.com/cb', 'http://example.com/cb'] }]),
    /auth\.clients\.1\.redirectUris\.1: Use an absolute https: URL, or an http: URL to 127\.0\.0\.1, localhost or \[::1\], without fragment or credentials\./);
  assert.match(refusal([{ ...registered, name: ' ' }]), /auth\.clients\.0\.name: Give the client a name\./);
  for (const bad of ['', 'gemini cli', 'gemini-cli/', 'client.example/metadata.json', 'urn:devmate:client', 'devmate:route-verification', 'http://127.0.0.1/client', '.hidden', '-flag', 'G' + 'x'.repeat(200), 'gemini' + String.fromCharCode(233), 42, null])
    assert.throws(() => normalizeConfig(settings([{ ...registered, clientId: bad }])), { name: 'ZodError' }, String(bad));
  for (const bad of ['http://example.com/cb', 'http://192.168.1.10/cb', 'http://localhost.example.com/cb', 'http://localhost./cb', 'https://example.com/cb#fragment', 'http://127.0.0.1/cb#', 'https://user:password@example.com/cb',
    '/oauth/callback', 'example.com/cb', 'cursor://callback', 'not a url', '', 'https://example.com/' + 'a'.repeat(2048), 42])
    assert.throws(() => normalizeConfig(settings([{ ...registered, redirectUris: ['https://example.com/cb', bad] }])), { name: 'ZodError' }, String(bad));
  for (const bad of [{ ...registered, name: 'n'.repeat(101) }, { ...registered, name: undefined }, { ...registered, redirectUris: uris(11) }, { ...registered, redirectUris: 'https://example.com/cb' },
    { ...registered, clientSecret: 'secret' }, { ...registered, grantTypes: ['refresh_token'] }, { clientId: 'gemini-cli' }, 'gemini-cli'])
    assert.throws(() => normalizeConfig(settings([bad])), { name: 'ZodError' }, JSON.stringify(bad));
  assert.throws(() => normalizeConfig(settings(Array.from({ length: 33 }, (_, index) => ({ ...registered, clientId: 'client-' + index })))), { name: 'ZodError' });
  assert.throws(() => normalizeConfig(settings({ 'gemini-cli': registered })), { name: 'ZodError' });
  // Sign-in is off in mode none, and so is everything that belongs to it.
  assert.throws(() => normalizeConfig({ auth: { mode: 'none', clients: [registered] } }), { name: 'ZodError' });

  // The sign-in itself holds to the same rules, whatever handed it its settings.
  const f = await fixture(t);
  const start = clients => createAuth({ store: f.store, instanceRoot: f.root, config: { mode: 'oauth', issuer, clients } });
  for (const clients of [[{ ...registered, clientId }], [{ ...registered, clientId: 'devmate:route-verification' }], [registered, registered], [{ ...registered, redirectUris: [] }],
    [{ ...registered, redirectUris: ['http://example.com/cb'] }], [{ ...registered, redirectUris: ['https://example.com/cb#fragment'] }], [{ ...registered, redirectUris: [42] }], [{ clientId: 'gemini-cli', name: 'Gemini CLI' }], [null]])
    assert.throws(() => start(clients), { code: 'invalid_auth_client' }, JSON.stringify(clients));
});
test('a client that publishes a metadata document signs in as before beside registered ones, and the metadata is unchanged', async t => {
  const plain = await fixture(t), f = await fixture(t, withClients());
  const page = await f.request('/oauth/authorize', f.query(), { method: 'GET' });
  assert.equal(page.status, 200); assert.match(page.text, /<strong>Fixture Client<\/strong>/); assert.equal(page.text.includes('registered this client'), false);
  const issued = await f.signIn();
  assert.deepEqual(f.principal(issued.access_token), { id: 'owner', role: 'owner', projectIds: null });
  assert.equal((await f.refresh(issued.refresh_token)).status, 200);
  assert.deepEqual([...new Set(f.fetched)], [clientId], 'its document is still what describes it');
  // Neither kind of client can use a redirect of the other.
  assert.equal((await f.request('/oauth/authorize', f.query({ redirect_uri: 'https://example.com/cb' }), { method: 'GET' })).status, 400);
  assert.equal((await f.request('/oauth/authorize', f.query({ client_id: registered.clientId }), { method: 'GET' })).status, 400);
  // A refresh token presented under the other client's name has left its owner's hands.
  const own = await f.signIn();
  assert.equal((await f.refresh(own.refresh_token, { client_id: registered.clientId })).json.error, 'invalid_grant'); assert.equal(f.principal(own.access_token), null);
  for (const pathname of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])
    assert.deepEqual((await f.request(pathname, {}, { method: 'GET' })).json, (await plain.request(pathname, {}, { method: 'GET' })).json, pathname);
  const server = (await f.request('/.well-known/oauth-authorization-server', {}, { method: 'GET' })).json;
  assert.equal(server.registration_endpoint, undefined); assert.equal(server.client_id_metadata_document_supported, true);
  assert.deepEqual(server.token_endpoint_auth_methods_supported, ['none']); assert.deepEqual(server.code_challenge_methods_supported, ['S256']);
  assert.equal((await f.request('/oauth/register', { client_name: 'Self-registered', redirect_uris: 'https://attacker.example/cb' })).handled, false);
  // In mode none there is no sign-in for a registered client to use.
  const none = await fixture(t, { config: { mode: 'none', clients: [registered] } });
  assert.equal((await none.request('/oauth/authorize', none.query(asRegistered), { method: 'GET' })).handled, false);
  assert.deepEqual(none.auth.authenticate({ headers: {} }), { id: 'owner', role: 'owner', projectIds: null });
  // The name the owner chose is shown as text.
  const hostile = await fixture(t, withClients({ ...registered, name: '<img src=x onerror=alert(1)> & "Co"' }));
  const shown = (await hostile.request('/oauth/authorize', hostile.query(asRegistered), { method: 'GET' })).text;
  assert.equal(shown.includes('<img'), false); assert.match(shown, /<strong>&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;Co&quot;<\/strong>/);
});
