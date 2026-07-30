import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runExternalRunner } from '../scripts/devmate-runner.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-external-runner-e2e-'));
const workspace = path.join(temp, 'workspace');
await fsp.mkdir(path.join(workspace, 'artifacts'), { recursive: true });

const localServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname === '/control/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: 'devmate', status: 'ok' }));
    return;
  }
  if (url.pathname === '/mcp' && req.method === 'GET') {
    res.writeHead(405, { allow: 'POST' });
    res.end();
    return;
  }
  if (url.pathname === '/mcp' && req.method === 'DELETE') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (url.pathname === '/mcp' && req.method === 'POST') {
    assert.match(String(req.headers.authorization || ''), /^Bearer local-owner-token/);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (rpc.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result;
    if (rpc.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'devmate', version: '2.3.0' }
      };
    } else if (rpc.method === 'tools/call') {
      assert.equal(rpc.params.name, 'run_smart_checks');
      assert.equal(rpc.params.arguments.workspaceId, 'app');
      await fsp.writeFile(path.join(workspace, 'artifacts', 'remote.json'), '{"ok":true}\n', 'utf8');
      result = {
        isError: false,
        content: [{ type: 'text', text: 'remote checks passed' }],
        structuredContent: { ok: true, reportPath: 'artifacts/remote.json' }
      };
    } else {
      result = {};
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
const localPort = localServer.address().port;

let claimCount = 0;
let completion = null;
const controlServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  assert.equal(req.headers['x-devmate-runner-protocol'], '1');
  assert.match(String(req.headers.authorization || ''), /^Bearer dmr_remote_/);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  const respond = payload => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ protocolVersion: 1, ...payload }));
  };
  if (url.pathname.endsWith('/heartbeat')) return respond({ runner: { id: 'remote' } });
  if (url.pathname.endsWith('/jobs/claim')) {
    claimCount += 1;
    return respond({
      job: claimCount === 1 ? {
        id: 'job-e2e',
        tool: 'run_smart_checks',
        workspaceId: 'app',
        arguments: { workspaceId: 'app' },
        artifactPaths: ['artifacts'],
        timeoutMs: 30000
      } : null
    });
  }
  if (url.pathname.endsWith('/renew')) return respond({ renewed: true, cancelRequested: false });
  if (url.pathname.endsWith('/complete')) {
    completion = body;
    return respond({ job: { id: 'job-e2e', status: 'succeeded' } });
  }
  if (url.pathname.endsWith('/fail') || url.pathname.endsWith('/cancelled')) {
    return respond({ job: { id: 'job-e2e', status: 'failed' } });
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});
await new Promise(resolve => controlServer.listen(0, '127.0.0.1', resolve));
const controlPort = controlServer.address().port;

const configPath = path.join(temp, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({
  appVersion: '2.3.0',
  instanceId: 'external-runner-e2e',
  server: { port: localPort, mcpPath: '/mcp' },
  auth: { required: true, token: 'local-owner-token-long-enough' },
  deployment: { mode: 'personal' },
  runtime: { maxConcurrentJobs: 1 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'app', root: workspace, mode: 'workspace-write', reference: false }],
  plugins: { enabled: [], settings: {} }
}, null, 2), 'utf8');

process.env.DEVMATE_RUNNER_TOKEN = 'dmr_remote_token-value-long-enough';

test('executes a remote job through the official local MCP client and reports artifacts', async () => {
  await runExternalRunner({
    config: configPath,
    'control-url': `http://127.0.0.1:${controlPort}`,
    'no-spawn': true,
    once: true,
    concurrency: '1',
    'poll-ms': '500'
  });
  assert.ok(completion);
  assert.equal(completion.result.structuredContent.ok, true);
  assert.equal(completion.artifacts.length, 1);
  assert.equal(completion.artifacts[0].path, 'artifacts/remote.json');
  assert.match(completion.artifacts[0].sha256, /^[a-f0-9]{64}$/);
});

test.after(async () => {
  delete process.env.DEVMATE_RUNNER_TOKEN;
  await new Promise(resolve => localServer.close(resolve));
  await new Promise(resolve => controlServer.close(resolve));
  await fsp.rm(temp, { recursive: true, force: true });
});
