import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { DevMateService } from '../runtime/service.mjs';
import { createCapabilities } from '../runtime/capabilities.mjs';

const localOwner = { id: 'owner', role: 'owner', surface: 'local' };
const issuer = 'https://review.devmate.example';
const clientId = 'https://review-client.example/client.json';
const redirectUri = 'http://127.0.0.1:54321/callback';
const verifier = 'v'.repeat(64);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-runtime-review-'));
  const publicRoot = path.join(root, 'public'), privateRoot = path.join(root, 'private');
  fs.mkdirSync(publicRoot); fs.mkdirSync(privateRoot);
  fs.writeFileSync(path.join(publicRoot, 'public.txt'), 'shared fixture');
  const privatePath = path.join(privateRoot, 'private.txt'), privateText = 'PRIVATE REVIEW FIXTURE';
  fs.writeFileSync(privatePath, privateText);
  const uri = pathToFileURL(privatePath).href;
  const evidence = { connected: 0, reads: 0 };
  const servers = [];
  const service = new DevMateService({
    instanceRoot: path.join(root, 'instance'), endpoint: 'http://127.0.0.1:1/api/agent',
    config: { auth: { mode: 'oauth', issuer }, connection: { kind: 'external-https', url: issuer + '/mcp' },
      externalServers: [{ id: 'fixture', transport: 'http', url: 'http://127.0.0.1:54322/mcp' }] },
    authOptions: { clientMetadata: async () => ({ client_id: clientId, client_name: 'Review Fixture', redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) },
    capabilitiesFactory: options => createCapabilities({ ...options, engines: [], transportFactory: async () => {
      evidence.connected++;
      const external = new McpServer({ name: 'privileged-fixture', version: '1.0.0' });
      external.registerResource('private-fixture', uri, { mimeType: 'text/plain' }, async requested => {
        evidence.reads++;
        return { contents: [{ uri: requested.href, mimeType: 'text/plain', text: fs.readFileSync(privatePath, 'utf8') }] };
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await external.connect(serverTransport); servers.push(external);
      return clientTransport;
    } })
  });
  t.after(async () => { await service.close(); for (const server of servers) await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = await service.call('project.create', { root: publicRoot }, localOwner);
  const privateProject = await service.call('project.create', { root: privateRoot }, localOwner);
  async function principal(role, projectIds = [project.id]) {
    const member = await service.call('auth.member.create', { name: role + ' fixture', role, projectIds }, localOwner);
    const login = await service.call('auth.code.create', { memberId: member.id }, localOwner);
    const request = async (pathname, params) => {
      const req = Readable.from([Buffer.from(new URLSearchParams(params).toString())]);
      req.method = 'POST'; req.headers = { 'content-type': 'application/x-www-form-urlencoded' };
      const res = { status: 0, headers: {}, text: '', writeHead(status, headers) { this.status = status; this.headers = headers; }, end(value = '') { this.text += value; } };
      assert.equal(await service.auth.handle(req, res, new URL(pathname, issuer)), true);
      return res;
    };
    const authorized = await request('/oauth/authorize', { client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
      resource: issuer + '/mcp', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      scope: 'devmate', authorization_code: login.code });
    assert.equal(authorized.status, 302, authorized.text);
    const exchanged = await request('/oauth/token', { grant_type: 'authorization_code', client_id: clientId, resource: issuer + '/mcp',
      redirect_uri: redirectUri, code_verifier: verifier, code: new URL(authorized.headers.Location).searchParams.get('code') });
    assert.equal(exchanged.status, 200, exchanged.text);
    const result = service.auth.authenticate({ headers: { authorization: 'Bearer ' + JSON.parse(exchanged.text).access_token } });
    assert.equal(result.role, role); assert.deepEqual(result.projectIds, projectIds);
    return result;
  }
  return { root, service, project, privateProject, privateText, uri, evidence, principal };
}

test('external MCP resources require owner even for an OAuth member granted the selected project', async t => {
  const f = await fixture(t), reader = await f.principal('read');
  assert.equal((await f.service.call('workspace.read', { projectId: f.project.id, path: 'public.txt' }, reader)).text, 'shared fixture');
  await assert.rejects(f.service.call('workspace.read', { projectId: f.privateProject.id, path: 'private.txt' }, reader), { code: 'forbidden' });
  const args = { projectId: f.project.id, capability: 'mcp.fixture.resources.read', input: { uri: f.uri } };
  await assert.rejects(f.service.call('capability.call', args, reader).then(result => {
    assert.equal(result.contents[0].text, f.privateText);
    t.diagnostic('Unexpected member access returned the exact private-project file through the external MCP server.');
    return result;
  }), { code: 'forbidden' },
    'A granted public project must not delegate the instance MCP credentials to read a private-project resource.');
  assert.equal(f.evidence.connected, 0, 'Reject before connecting or using external credentials.');
  const ownerResult = await f.service.call('capability.call', args, localOwner);
  assert.equal(ownerResult.contents[0].text, f.privateText);
  assert.equal(f.evidence.reads, 1);
});

test('external MCP discovery is hidden from members and cannot establish a privileged connection', async t => {
  const f = await fixture(t);
  for (const role of ['read', 'write']) {
    const principal = await f.principal(role);
    const catalog = await f.service.call('capability.list', { projectId: f.project.id }, principal);
    assert.deepEqual(catalog.externalServers, []);
    await assert.rejects(f.service.call('capability.list', { projectId: f.project.id, serverId: 'fixture' }, principal), { code: 'forbidden' });
    await assert.rejects(f.service.call('capability.call', { projectId: f.project.id, capability: 'mcp.fixture.discover' }, principal), { code: 'forbidden' });
  }
  assert.equal(f.evidence.connected, 0);
  assert.equal((await f.service.call('capability.list', { projectId: f.project.id, serverId: 'fixture' }, localOwner)).external.serverId, 'fixture');
});

test('settings read and replace require the local owner, including operation discovery', async t => {
  const f = await fixture(t), writer = await f.principal('write');
  for (const context of [writer, { ...writer, surface: 'local' }, { id: 'owner', role: 'owner', projectIds: null }]) {
    const names = f.service.visibleOperations(context).map(operation => operation.name);
    assert.equal(names.includes('settings.read'), false); assert.equal(names.includes('settings.replace'), false);
    await assert.rejects(f.service.call('settings.read', {}, context), { code: 'forbidden' });
    await assert.rejects(f.service.call('settings.replace', { config: {} }, context), { code: 'forbidden' });
  }
  assert.ok(await f.service.call('settings.read', {}, localOwner));
  assert.equal(fs.existsSync(path.join(f.root, 'instance', 'config.json')), false);
});

test('operation IDs are isolated by authenticated identity and never bypass current project grants', async t => {
  const f = await fixture(t), first = await f.principal('write'), second = await f.principal('write');
  const args = { projectId: f.project.id, title: 'One operation', operationId: 'same-operation' };
  const one = await f.service.call('workflow.create', args, first);
  assert.equal((await f.service.call('workflow.create', args, first)).id, one.id);
  assert.notEqual((await f.service.call('workflow.create', args, second)).id, one.id);
  await assert.rejects(f.service.call('workflow.create', { ...args, title: 'Changed' }, first), { code: 'operation_conflict' });
  await assert.rejects(f.service.call('workflow.create', args, { ...first, projectIds: [] }), { code: 'forbidden' });
  await assert.rejects(f.service.call('workflow.create', { ...args, projectId: f.privateProject.id }, first), { code: 'forbidden' });
});
