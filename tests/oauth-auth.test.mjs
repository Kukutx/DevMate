import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import configStore from '../shared/config-store.cjs';

function freePort() {
  return 19000 + Math.floor(Math.random() * 5000);
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForGateway(port, child, output) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`OAuth Gateway exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`OAuth Gateway did not become ready: ${output()}`);
}

test('optional OAuth uses protected-resource discovery, PKCE, refresh tokens, and rejects unauthenticated MCP', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-oauth-'));
  const port = freePort();
  const configPath = path.join(directory, 'config.json');
  const config = configStore.newInstanceConfig({ workspaceRoot: process.cwd(), port, appVersion: '3.4.3' });
  config.auth = {
    mode: 'oauth',
    oauth: {
      signingKey: crypto.randomBytes(32).toString('base64url'),
      approvalCode: 'oauth-approval-code-for-test'
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(config), 'utf8');
  const child = spawn(process.execPath, ['gateway/server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await waitForGateway(port, child, () => output);
  const origin = `http://127.0.0.1:${port}`;
  const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  const resource = await metadata.json();
  assert.deepEqual(resource.authorization_servers, [origin]);
  assert.equal(resource.resource, `${origin}/mcp`);

  const noAuth = await fetch(`${origin}/mcp`, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') || '', /resource_metadata=/);

  const registration = await fetch(`${origin}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://127.0.0.1:43123/callback'], application_type: 'native' })
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${origin}/oauth/authorize`);
  authorize.searchParams.set('client_id', client.client_id);
  authorize.searchParams.set('redirect_uri', 'http://127.0.0.1:43123/callback');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('resource', `${origin}/mcp`);
  authorize.searchParams.set('scope', 'devmate offline_access');
  authorize.searchParams.set('state', 'state-1');
  const consent = new URLSearchParams(authorize.searchParams);
  consent.set('approval_code', config.auth.oauth.approvalCode);
  const approved = await fetch(authorize, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: consent, redirect: 'manual' });
  assert.equal(approved.status, 302);
  const rotatedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.notEqual(rotatedConfig.auth.oauth.approvalCode, config.auth.oauth.approvalCode);
  const callback = new URL(approved.headers.get('location'));
  assert.equal(callback.searchParams.get('state'), 'state-1');
  assert.equal(callback.searchParams.get('iss'), origin);

  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      redirect_uri: 'http://127.0.0.1:43123/callback',
      code: callback.searchParams.get('code'),
      code_verifier: verifier,
      resource: `${origin}/mcp`
    })
  });
  assert.equal(tokenResponse.status, 200);
  const issued = await tokenResponse.json();
  assert.equal(issued.token_type, 'Bearer');
  assert.ok(issued.refresh_token);

  const protectedCall = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${issued.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  assert.equal(protectedCall.status, 200);

  const refreshed = await fetch(`${origin}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, resource: `${origin}/mcp` })
  });
  assert.equal(refreshed.status, 200);
  assert.ok((await refreshed.json()).access_token);
});
