import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, issuer } from './runtime-integration-fixtures.mjs';
import { WORKBENCH_RESOURCE_URI, WORKBENCH_MIME } from '../runtime/workbench.mjs';

const config = { auth: { mode: 'oauth', issuer } };
function result(response) {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.error, undefined, response.text);
  return response.body.result;
}

test('real OAuth HTTP authenticates every MCP request: the signed-in owner gets the tools, the route check one question', async t => {
  const f = await fixture(t, { config });
  const a = await f.project('first'), b = await f.project('second');
  // These inert records exercise what a snapshot shows; no native account or approval is impersonated.
  for (const scope of [a.scope, b.scope]) for (const kind of ['approval', 'input']) f.runtime.service.store.create(kind, {
    ...scope, status: 'pending', details: { sentinel: scope.projectId }, summary: kind + ' fixture'
  });
  const owner = await f.authorize();
  // Sign-in guards the public address. A caller without credentials is refused there, with a challenge that says where to sign in.
  const publicHost = { host: new URL(issuer).host };
  const challenged = await f.rpc('tools/list', {}, publicHost);
  assert.equal(challenged.status, 401);
  assert.match(challenged.headers['www-authenticate'], /^Bearer resource_metadata="https:\/\/devmate-integration\.example\/\.well-known\/oauth-protected-resource\/mcp", scope="devmate"$/);
  const forged = await f.rpc('tools/list', {}, { ...publicHost, authorization: 'Bearer not-a-token' });
  assert.equal(forged.status, 401); assert.match(forged.headers['www-authenticate'], /error="invalid_token"/);
  // On this computer the owner needs no sign-in, so local clients keep working when sign-in is switched on; a presented token still decides who the caller is.
  assert.equal((await f.rpc('tools/list')).status, 200);
  assert.equal((await f.rpc('tools/list', {}, { authorization: 'Bearer not-a-token' })).status, 401);
  const ownerProjects = (await f.tool('project_list', {}, owner)).structuredContent.items;
  assert.equal(ownerProjects.length, 2);
  const ownerTools = result(await f.rpc('tools/list', {}, owner)).tools;
  // What only the workbench needs is not a tool at all: a client that ignores visibility hints cannot show it to a model.
  for (const absent of ['project_remove', 'approval_resolve', 'input_respond', 'task_create']) assert.equal(ownerTools.some(tool => tool.name === absent), false, absent);
  assert.ok(ownerTools.some(tool => tool.name === 'project_list'));
  assert.deepEqual(ownerTools.filter(tool => tool._meta?.ui?.visibility?.join() === 'app').map(tool => tool.name), ['workbench_call']);
  // A signed-in client is the owner as a connected client: what is decided at the owner's computer is not offered to it.
  for (const hidden of ['project_create', 'approval_resolve', 'input_respond', 'auth_code_create', 'settings_read', 'runtime_stop'])
    assert.equal(ownerTools.some(tool => tool.name === hidden), false, hidden);
  for (const operation of ['approval.list', 'input.list']) {
    const listed = (await f.tool('operations_query', { operation, input: { projectId: a.project.id } }, owner)).structuredContent.items;
    assert.equal(listed.length, 1, operation); assert.equal(listed[0].projectId, a.project.id);
  }
  const opened = await f.tool('open_devmate_workbench', { projectId: a.project.id }, owner);
  assert.deepEqual(Object.keys(opened.structuredContent).sort(), ['counts', 'selection'], 'opening does not put the workspace into the conversation');
  const snapshot = input => f.tool('workbench_call', { operation: 'workbench.snapshot', input }, owner);
  const global = await snapshot({});
  assert.deepEqual(global.structuredContent.projects.map(item => item.id).sort(), [a.project.id, b.project.id].sort());
  assert.deepEqual(global.structuredContent.approvals, []); assert.deepEqual(global.structuredContent.inputs, []);
  const scoped = await snapshot({ projectId: a.project.id });
  assert.equal(scoped.structuredContent.approvals.length, 1);
  assert.equal(scoped.structuredContent.inputs.length, 1);
  // The runtime's own check of the public route signs in as itself, and finds the one tool that says which runtime answers.
  const probe = { ...publicHost, authorization: 'Bearer ' + f.runtime.service.auth.issueVerificationToken().accessToken };
  assert.deepEqual(result(await f.rpc('tools/list', {}, probe)).tools.map(tool => tool.name), ['connection_status']);
  assert.equal((await f.tool('connection_status', {}, probe)).structuredContent.instance.generation, f.runtime.service.identity.generation);
  for (const [method, params] of [['tools/call', { name: 'project_list', arguments: {} }], ['tools/call', { name: 'workbench_call', arguments: { operation: 'project.list', input: {} } }],
    ['resources/read', { uri: 'devmate://project/' + a.project.id + '/file/anything.txt' }]]) {
    const refused = await f.rpc(method, params, probe);
    assert.ok(refused.body?.error || refused.body?.result?.isError, method + ' ' + (params.name || params.uri) + ': ' + refused.text);
    assert.equal(refused.text.includes(a.root), false);
  }
  // Both on the same listener, at the same time.
  const concurrent = await Promise.all([f.rpc('tools/list', {}, owner), f.rpc('tools/list', {}, probe)]);
  assert.deepEqual(concurrent.map(response => result(response).tools.length > 1), [true, false]);
  // A sign-in the owner revokes stops working at once; at this computer nothing changes.
  const grant = (await f.call('auth.grant.list')).items.find(item => item.purpose === 'client');
  await f.call('auth.grant.revoke', { id: grant.id });
  const revoked = await f.rpc('tools/list', {}, owner);
  assert.equal(revoked.status, 401); assert.match(revoked.headers['www-authenticate'], /error="invalid_token"/);
  assert.equal((await f.rpc('tools/list')).status, 200);
});

test('a client registered in the configuration signs in over real HTTP with PKCE, calls MCP and refreshes', async t => {
  const registered = { clientId: 'gemini-cli', name: 'Gemini CLI', redirectUris: ['http://127.0.0.1/oauth/callback', 'https://example.com/cb'] };
  const f = await fixture(t, { config: { auth: { ...config.auth, clients: [registered] } } });
  await f.project('registered-client');
  const host = new URL(issuer).host, verifier = 'r'.repeat(64), redirectUri = 'http://127.0.0.1:49152/oauth/callback';
  const post = (pathname, fields) => f.request(pathname, { method: 'POST', headers: { host, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  const bearer = token => ({ host, authorization: 'Bearer ' + token });
  const sign = { client_id: registered.clientId, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'devmate offline_access', state: 'registered-client-state' };
  const page = await f.request('/oauth/authorize?' + new URLSearchParams(sign), { headers: { host } });
  assert.equal(page.status, 200, page.text); assert.match(page.text, /<strong>Gemini CLI<\/strong>/); assert.match(page.text, /The owner of this DevMate registered this client/);
  // Without PKCE, at another path or under a name nobody registered, the same one-time code opens nothing.
  const login = await f.call('auth.code.create');
  const { code_challenge, code_challenge_method, ...withoutPkce } = sign;
  for (const refused of [withoutPkce, { ...sign, redirect_uri: 'http://127.0.0.1:49152/other' }, { ...sign, redirect_uri: 'http://example.com/cb' }, { ...sign, client_id: 'my-desktop-client' }]) {
    const response = await post('/oauth/authorize', { ...refused, authorization_code: login.code });
    assert.equal(response.status, 400, response.text); assert.equal(response.headers.location, undefined);
  }
  const authorized = await post('/oauth/authorize', { ...sign, authorization_code: login.code });
  assert.equal(authorized.status, 302, authorized.text);
  const redirect = new URL(authorized.headers.location);
  assert.equal(redirect.origin + redirect.pathname, redirectUri, 'a loopback redirect returns to the port the client chose');
  assert.equal(redirect.searchParams.get('state'), sign.state); assert.equal(redirect.searchParams.get('iss'), issuer);
  const token = { grant_type: 'authorization_code', client_id: registered.clientId, resource: issuer + '/mcp', redirect_uri: redirectUri, code: redirect.searchParams.get('code') };
  const wrong = await post('/oauth/token', { ...token, code_verifier: 'x'.repeat(64) });
  assert.equal(wrong.status, 400); assert.equal(wrong.body.error, 'invalid_grant');
  const issued = await post('/oauth/token', { ...token, code_verifier: verifier });
  assert.equal(issued.status, 200, issued.text); assert.equal(issued.body.token_type, 'Bearer'); assert.equal(issued.body.scope, 'devmate offline_access');
  assert.equal((await f.tool('project_list', {}, bearer(issued.body.access_token))).structuredContent.items.length, 1);
  const refreshed = await post('/oauth/token', { grant_type: 'refresh_token', client_id: registered.clientId, refresh_token: issued.body.refresh_token });
  assert.equal(refreshed.status, 200, refreshed.text); assert.notEqual(refreshed.body.refresh_token, issued.body.refresh_token);
  assert.equal(result(await f.rpc('tools/list', {}, bearer(refreshed.body.access_token))).tools.some(tool => tool.name === 'project_list'), true);
  assert.equal((await post('/oauth/revoke', { client_id: registered.clientId, token: refreshed.body.refresh_token })).status, 200);
  assert.equal((await f.rpc('tools/list', {}, bearer(refreshed.body.access_token))).status, 401);
  // The client that publishes a metadata document signs in beside it exactly as before, and nothing invites self-registration.
  assert.equal((await f.tool('project_list', {}, await f.authorize())).structuredContent.items.length, 1);
  const metadata = (await f.request('/.well-known/oauth-authorization-server', { headers: { host } })).body;
  assert.equal(metadata.registration_endpoint, undefined); assert.equal(metadata.client_id_metadata_document_supported, true);
  assert.equal((await post('/oauth/register', { client_name: 'Self-registered' })).status, 404);
});

test('public Host cannot obtain local workbench cookies or use the local owner token on private APIs', async t => {
  const f = await fixture(t, { config });
  const headers = { host: new URL(issuer).host, authorization: 'Bearer ' + f.token };
  for (const route of ['/', '/workbench', '/api/snapshot', '/health']) {
    const response = await f.request(route, { headers });
    assert.equal(response.status, 404, route + ': ' + response.text);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.text.includes(f.token), false);
  }
  const api = await f.local('project.list', {}, headers);
  assert.equal(api.status, 404);
  assert.equal((await f.rpc('tools/list', {}, headers)).status, 401, 'owner-token is not an OAuth access token');
  // Locally the workbench is entered with a single-use link; opening the address alone gives a page that holds nothing.
  const home = await f.request('/');
  assert.equal(home.status, 200); assert.equal(home.headers['set-cookie'], undefined); assert.equal(home.text.includes(f.token), false);
  assert.equal((await f.request('/api/snapshot')).status, 401);
  const issued = await f.request('/api/session', { method: 'POST', headers: { authorization: 'Bearer ' + f.token } });
  const entered = await f.request('/api/session/exchange', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: new URL(issued.body.result.url).searchParams.get('code') }) });
  assert.equal(entered.status, 200); assert.equal(entered.headers['set-cookie'], undefined);
  const snapshot = await f.request('/api/snapshot', { headers: { authorization: 'Bearer ' + entered.body.result.session } });
  assert.equal(snapshot.status, 200); assert.equal(snapshot.body.result.instance.name, 'DevMate');
  assert.equal((await f.request('/', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});

test('real MCP resource reads preserve project text, task and binary artifact', async t => {
  const f = await fixture(t, { config });
  const a = await f.project('readable');
  fs.mkdirSync(path.join(a.root, 'nested'));
  fs.writeFileSync(path.join(a.root, 'nested', '中文 name.txt'), 'readable contents');
  fs.writeFileSync(path.join(a.root, 'artifact.bin'), Buffer.from([0, 1, 128, 255]));
  const task = await f.call('task.create', { ...a.scope, title: 'readable', instruction: 'inspect only' });
  const artifact = await f.call('artifact.create', { ...a.scope, path: 'artifact.bin', mimeType: 'application/octet-stream' });
  const owner = await f.authorize();
  const visible = [];
  for (const uri of ['devmate://project/' + a.project.id + '/file/nested/' + encodeURIComponent('中文 name.txt'), 'devmate://task/' + task.id, 'devmate://artifact/' + artifact.id])
    visible.push(result(await f.rpc('resources/read', { uri }, owner)).contents[0]);
  assert.equal(visible[0].text, 'readable contents');
  assert.equal(JSON.parse(visible[1].text).id, task.id);
  assert.equal(visible[2].blob, Buffer.from([0, 1, 128, 255]).toString('base64'));
  assert.equal(visible[2].mimeType, 'application/octet-stream');
  for (const uri of ['devmate://project/project-does-not-exist/file/nested/x.txt', 'devmate://task/task-does-not-exist']) {
    const missing = await f.rpc('resources/read', { uri }, owner);
    assert.equal(missing.status, 200, missing.text); assert.ok(missing.body.error, missing.text); assert.equal(missing.body.result, undefined);
  }
  const tools = result(await f.rpc('tools/list', {}, owner)).tools;
  const launcher = tools.find(item => item.name === 'open_devmate_workbench');
  assert.deepEqual(launcher._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
  assert.equal(launcher._meta.ui.resourceUri, WORKBENCH_RESOURCE_URI);
  assert.deepEqual(tools.find(item => item.name === 'workbench_call')._meta.ui.visibility, ['app']);
  const ui = result(await f.rpc('resources/read', { uri: WORKBENCH_RESOURCE_URI }, owner)).contents[0];
  assert.equal(ui.mimeType, WORKBENCH_MIME);
  assert.deepEqual(Object.keys(ui._meta), ['ui'], 'the resource carries only what the MCP Apps standard defines');
  assert.deepEqual(ui._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.match(ui.text, /DevMate/); assert.match(ui.text, /ui\/initialize/);
});

test('parallel requests of the signed-in owner and of the route check do not cross-contaminate identities', async t => {
  const f = await fixture(t, { config });
  await f.project('parallel-left'); await f.project('parallel-right');
  const owner = await f.authorize();
  const probe = { host: new URL(issuer).host, authorization: 'Bearer ' + f.runtime.service.auth.issueVerificationToken().accessToken };
  const results = await Promise.all(Array.from({ length: 48 }, (_, i) => f.rpc('tools/list', {}, i % 2 ? probe : owner)));
  results.forEach((response, i) => {
    const names = result(response).tools.map(tool => tool.name);
    if (i % 2) assert.deepEqual(names, ['connection_status']);
    else assert.ok(names.includes('project_list') && names.length > 30, names.join());
  });
});
