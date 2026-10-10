import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { startRuntime } from '../runtime/main.mjs';

export const protocol = '2026-07-28';
export const issuer = 'https://devmate-integration.example';
const clientId = 'https://client.example/devmate-integration.json';
const redirectUri = 'http://127.0.0.1:55123/callback';
const verifier = 'v'.repeat(64);
const metadata = { client_id: clientId, client_name: 'Isolated integration fixture', redirect_uris: [redirectUri],
  token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label = 'condition', timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(10); }
  throw new Error('Timed out: ' + label);
}
export function httpRequest(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers,
      signal: AbortSignal.timeout(15000) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, body: json });
      });
    });
    req.on('error', reject); req.end(body);
  });
}
export async function fixture(t, { config = {}, ...extra } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-integration-'));
  const instanceRoot = path.join(temp, 'instance'); fs.mkdirSync(instanceRoot);
  fs.writeFileSync(path.join(instanceRoot, 'config.json'), JSON.stringify(config));
  let runtime;
  t.after(async () => {
    if (runtime) await runtime.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  runtime = await startRuntime({ instanceRoot, port: 0, authOptions: { clientMetadata: async () => metadata },
    connectionFactory: () => ({ async start() {}, async stop() {}, status() { return { kind: 'local', status: 'ready' }; } }), ...extra });
  const token = fs.readFileSync(path.join(instanceRoot, 'owner-token'), 'utf8');
  // Requests addressed to the public host arrive through the separate ingress listener.
  const request = (pathname, options) => httpRequest(options?.headers?.host ? runtime.ingressPort : runtime.port, pathname, options);
  const local = (operation, input = {}, headers = {}) => request('/api/call', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, ...headers }, body: JSON.stringify({ operation, input }) });
  const call = async (operation, input = {}) => {
    const response = await local(operation, input);
    assert.equal(response.status, 200, response.text); assert.equal(response.body.ok, true, response.text);
    return response.body.result;
  };
  let sequence = 0;
  const rpc = (method, params = {}, headers = {}) => request('/mcp', { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': protocol, 'mcp-method': method, ...((params.name || params.uri) ? { 'mcp-name': params.name || params.uri } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': protocol,
      'io.modelcontextprotocol/clientInfo': { name: 'devmate-integration-fixture', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': headers['x-test-app-host'] ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } : {}
    } } }) });
  const tool = async (name, args = {}, headers = {}) => {
    const response = await rpc('tools/call', { name, arguments: args }, headers);
    assert.equal(response.status, 200, response.text); assert.equal(response.body.error, undefined, response.text);
    return response.body.result;
  };
  const authorize = async memberId => {
    const login = await call('auth.code.create', memberId ? { memberId } : {});
    const headers = { host: new URL(issuer).host, 'content-type': 'application/x-www-form-urlencoded' };
    const authorized = await request('/oauth/authorize', { method: 'POST', headers, body: new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', resource: issuer + '/mcp',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      scope: 'devmate offline_access', state: 'isolated-fixture-state', authorization_code: login.code
    }).toString() });
    assert.equal(authorized.status, 302, authorized.text);
    const redirect = new URL(authorized.headers.location);
    assert.equal(redirect.searchParams.get('state'), 'isolated-fixture-state');
    const exchanged = await request('/oauth/token', { method: 'POST', headers, body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, resource: issuer + '/mcp', redirect_uri: redirectUri,
      code_verifier: verifier, code: redirect.searchParams.get('code')
    }).toString() });
    assert.equal(exchanged.status, 200, exchanged.text);
    return { host: new URL(issuer).host, authorization: 'Bearer ' + exchanged.body.access_token };
  };
  const project = async (name = 'project') => {
    const root = path.join(temp, name); fs.mkdirSync(root);
    const project = await call('project.create', { root, name });
    const workflow = await call('workflow.create', { projectId: project.id, title: name });
    return { project, workflow, root, scope: { projectId: project.id, workflowId: workflow.id } };
  };
  return { temp, instanceRoot, runtime, request, local, call, rpc, tool, authorize, project, token };
}
