import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from '../runtime/store.mjs';
import { createAuth } from '../runtime/auth.mjs';
import { createClientMetadataResolver, validateClientMetadata } from '../runtime/auth-client.mjs';

// The documents in tests/fixtures/oauth are what these clients publish (see the README
// there). Each test signs the client in the way its vendor documents: the redirect it
// sends, the scopes it asks for, and no client authentication.
const issuer = 'https://devmate.example';
const resource = issuer + '/mcp';
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'oauth');
const verifier = 'real-client-verifier-'.repeat(3);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const clients = [
  { name: 'ChatGPT web', file: 'chatgpt.client.json', cacheControl: 'public, max-age=300', clientId: 'https://chatgpt.com/oauth/client.json',
    redirects: ['https://chatgpt.com/connector_platform_oauth_redirect'], scope: 'devmate',
    refused: ['https://chatgpt.com/connector_platform_oauth_redirect/', 'https://chatgpt.com/other', 'https://chatgpt.com.attacker.example/connector_platform_oauth_redirect', 'http://127.0.0.1:1234/callback'] },
  { name: 'Claude (claude.ai, Desktop, mobile)', file: 'claude-hosted.client.json', cacheControl: 'public, max-age=300', clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
    redirects: ['https://claude.ai/api/mcp/auth_callback'], scope: 'devmate offline_access',
    refused: ['https://claude.ai/api/mcp/auth_callback?x=1', 'https://claude.ai:8443/api/mcp/auth_callback', 'http://localhost:3118/callback'] },
  { name: 'Claude Code', file: 'claude-code.client.json', cacheControl: 'public, max-age=300', clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
    // Declared without a port; sent with the port the CLI is listening on.
    redirects: ['http://localhost:3118/callback', 'http://127.0.0.1:54321/callback', 'http://localhost/callback'], scope: 'devmate offline_access',
    refused: ['http://localhost:3118/other', 'http://localhost:3118/callback/extra', 'https://localhost:3118/callback', 'http://[::1]:3118/callback', 'http://localhost.attacker.example:3118/callback'] },
  { name: 'Codex CLI', file: 'codex-cli.client.json', cacheControl: 'public, max-age=300', clientId: 'https://chatgpt.com/oauth/codex/client.json',
    redirects: ['http://127.0.0.1:1455/callback', 'http://127.0.0.1:60123/callback'], scope: 'devmate',
    // The per-server callback path belongs to the per-server document, not to this shared one.
    refused: ['http://127.0.0.1:1455/callback/abc123', 'http://127.0.0.2:1455/callback', 'http://user@127.0.0.1:1455/callback'] },
  { name: 'VS Code', file: 'vscode.client.json', cacheControl: 'no-store,no-cache,max-age=0', clientId: 'https://vscode.dev/oauth/client-metadata.json',
    redirects: ['http://127.0.0.1:33418/', 'https://vscode.dev/redirect', 'http://127.0.0.1:50000/'], scope: 'devmate',
    refused: ['http://127.0.0.1:33418/callback', 'https://vscode.dev/redirect/', 'http://localhost:33418/'] }
].map(client => ({ ...client, bytes: fs.readFileSync(path.join(directory, client.file)) }));

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-auth-clients-'));
  const store = new Store(root), fetched = [];
  // The real resolver, with only DNS and the HTTPS socket replaced: it serves the saved bytes.
  const clientMetadata = createClientMetadataResolver({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], request(url, options, onResponse) {
    const req = new EventEmitter(); req.destroy = () => {}; fetched.push(url.href);
    req.end = () => queueMicrotask(() => {
      const found = clients.find(client => client.clientId === url.href), res = new PassThrough();
      res.statusCode = found ? 200 : 404; res.headers = { 'content-type': 'application/json', ...(found ? { 'cache-control': found.cacheControl } : {}) };
      onResponse(res); if (!res.destroyed) res.end(found ? found.bytes : '{}');
    });
    return req;
  } });
  const auth = createAuth({ store, instanceRoot: root, config: { mode: 'oauth', issuer }, clientMetadata });
  t.after(() => { auth.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  async function request(pathname, params = {}, { method = 'POST', headers = {} } = {}) {
    const encoded = new URLSearchParams(params), url = new URL(pathname, issuer);
    if (method === 'GET') url.search = encoded;
    const req = Readable.from(method === 'GET' ? [] : [Buffer.from(encoded.toString())]);
    req.method = method; req.headers = { 'content-type': 'application/x-www-form-urlencoded', ...headers };
    const response = { status: null, headers: {}, text: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value = '') { this.text += value; } };
    assert.equal(await auth.handle(req, response, url), true);
    let json; try { json = JSON.parse(response.text); } catch {}
    return { ...response, json };
  }
  const loginCode = () => auth.operations.find(op => op.name === 'auth.code.create').run({}).code;
  return { auth, store, request, loginCode, fetched };
}

test('the saved documents are the ones the clients publish', () => {
  for (const client of clients) {
    const document = JSON.parse(client.bytes.toString('utf8'));
    assert.equal(document.client_id, client.clientId, client.name);
    const validated = validateClientMetadata(document, client.clientId);
    assert.equal(validated.grant_types.includes('refresh_token'), true, client.name + ' declares the refresh_token grant');
  }
  const chatgpt = JSON.parse(clients[0].bytes.toString('utf8'));
  assert.equal(chatgpt.token_endpoint_auth_method, 'private_key_jwt');
  assert.deepEqual(chatgpt.token_endpoint_auth_methods_supported, ['none', 'private_key_jwt']);
  for (const loopbackOnly of [clients[2], clients[3]]) for (const uri of JSON.parse(loopbackOnly.bytes.toString('utf8')).redirect_uris) assert.equal(new URL(uri).port, '', loopbackOnly.name + ' declares no port');
});

for (const client of clients) {
  test(client.name + ' signs in, receives a rotating refresh token and is refused any other redirect', async t => {
    const f = await fixture(t);
    const query = redirect => ({ client_id: client.clientId, redirect_uri: redirect, response_type: 'code', resource, code_challenge: challenge,
      code_challenge_method: 'S256', scope: client.scope, state: 'state-' + client.file });
    for (const redirect of client.redirects) {
      const page = await f.request('/oauth/authorize', query(redirect), { method: 'GET' });
      assert.equal(page.status, 200, redirect + ': ' + page.text);
      const target = new URL(redirect);
      assert.equal(page.text.includes('<strong>' + JSON.parse(client.bytes.toString('utf8')).client_name + '</strong>'), true);
      assert.equal(page.text.includes('<strong>' + target.host + '</strong>'), true, 'the page names the host it returns to');
      assert.equal(page.text.includes('local application'), target.protocol === 'http:', 'a loopback redirect carries the warning');
      assert.equal(page.headers['Content-Security-Policy'].includes("form-action 'self' " + target.origin + ';'), true);

      const authorized = await f.request('/oauth/authorize', { ...query(redirect), authorization_code: f.loginCode() }, { headers: { origin: issuer } });
      assert.equal(authorized.status, 302, redirect + ': ' + authorized.text);
      const location = new URL(authorized.headers.Location);
      assert.equal(location.origin + location.pathname, target.origin + target.pathname);
      assert.equal(location.searchParams.get('state'), 'state-' + client.file); assert.equal(location.searchParams.get('iss'), issuer);

      const token = { grant_type: 'authorization_code', client_id: client.clientId, code: location.searchParams.get('code'), code_verifier: verifier, redirect_uri: redirect, resource };
      // The server advertises only "none", so a client able to sign assertions must not use one here.
      const asserted = await f.request('/oauth/token', { ...token, client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: 'header.payload.signature' });
      assert.equal(asserted.json.error, 'invalid_client');
      const issued = await f.request('/oauth/token', token);
      assert.equal(issued.status, 200, issued.text);
      assert.equal(issued.json.token_type, 'Bearer'); assert.equal(issued.json.scope, client.scope);
      assert.ok(issued.json.refresh_token, 'no second sign-in after fifteen minutes');
      assert.deepEqual(f.auth.authenticate({ headers: { authorization: 'Bearer ' + issued.json.access_token } }), { id: 'owner', role: 'owner', projectIds: null });

      const refreshed = await f.request('/oauth/token', { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: issued.json.refresh_token, resource });
      assert.equal(refreshed.status, 200, refreshed.text); assert.notEqual(refreshed.json.refresh_token, issued.json.refresh_token);
      assert.ok(f.auth.authenticate({ headers: { authorization: 'Bearer ' + refreshed.json.access_token } }));
    }
    for (const redirect of client.refused) {
      const page = await f.request('/oauth/authorize', query(redirect), { method: 'GET' });
      assert.equal(page.status, 400, redirect); assert.match(page.text, /redirect_uri is not one the client declares/);
    }
    assert.deepEqual(f.fetched, [client.clientId], 'one fetch serves the whole sign-in, whatever the document says about caching');
    assert.deepEqual(f.store.list('auth-grant').map(grant => grant.clientId), client.redirects.map(() => client.clientId));
  });
}

test('a sign-in with no scope parameter is granted the resource scope', async t => {
  const f = await fixture(t), client = clients[0];
  const authorized = await f.request('/oauth/authorize', { client_id: client.clientId, redirect_uri: client.redirects[0], response_type: 'code', resource,
    code_challenge: challenge, code_challenge_method: 'S256', authorization_code: f.loginCode() });
  assert.equal(authorized.status, 302, authorized.text);
  const issued = await f.request('/oauth/token', { grant_type: 'authorization_code', client_id: client.clientId, code: new URL(authorized.headers.Location).searchParams.get('code'), code_verifier: verifier });
  assert.equal(issued.json.scope, 'devmate'); assert.ok(issued.json.refresh_token);
});

test('an identifier no client publishes is refused without being remembered as a client', async t => {
  const f = await fixture(t);
  const page = await f.request('/oauth/authorize', { client_id: 'https://chatgpt.com/oauth/missing/client.json', redirect_uri: 'https://chatgpt.com/connector/oauth/missing',
    response_type: 'code', resource, code_challenge: challenge, code_challenge_method: 'S256' }, { method: 'GET' });
  assert.equal(page.status, 400); assert.match(page.text, /could not be verified from https:\/\/chatgpt\.com\/oauth\/missing\/client\.json/); assert.match(page.text, /HTTP 200/);
  assert.equal(f.store.list('auth-code').length, 0);
});
