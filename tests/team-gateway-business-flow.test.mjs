import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function structured(result) {
  return result.json?.result?.structuredContent || null;
}

function assertToolSuccess(result, label) {
  assert.equal(result.response.ok, true, `${label} HTTP failed: ${result.text}`);
  assert.equal(!!result.json?.error, false, `${label} RPC failed: ${result.text}`);
  assert.notEqual(result.json?.result?.isError, true, `${label} tool failed: ${result.text}`);
}

function assertToolFailure(result, pattern, label) {
  const failed = !!result.json?.error || result.json?.result?.isError === true;
  assert.equal(failed, true, `${label} unexpectedly succeeded: ${result.text}`);
  assert.match(result.text, pattern, `${label} failed for the wrong reason`);
}

test('real MCP team flow closes auth, work-session, lease, write, finish and rollback lifecycle', async () => {
  const root = process.cwd();
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-team-e2e-'));
  const workspaceRoot = path.join(temp, 'workspace');
  const configPath = path.join(temp, 'config.json');
  const port = await freePort();
  const ownerToken = 'team-e2e-owner-token';
  await fsp.mkdir(workspaceRoot, { recursive: true });

  const config = {
    version: 11,
    appVersion: '3.3.0',
    instanceId: `team-e2e-${Date.now()}`,
    server: { port, mcpPath: '/mcp' },
    runtime: { defaultCommandTimeoutMs: 30000, maxOutputChars: 80000 },
    maintenance: { backupRetentionDays: 30, auditRetentionDays: 30, maxBackupBytes: 268435456, maxAuditBytes: 5242880 },
    auth: { required: true, token: ownerToken },
    permissions: { profile: 'fullAccess', readOnly: false, blockDangerousOperations: true, confirmBeforePush: true, allowDirectoryMutations: false },
    deployment: { mode: 'team', tunnelProvider: 'external', publicUrl: 'https://team-e2e.example.com' },
    team: {
      enabled: true,
      members: [],
      requireWorkspaceLeaseForWrites: true,
      approvals: { enabled: false, requiredCapabilities: [], requiredTools: [], separationOfDuties: true }
    },
    production: { allowedHosts: [], maxRequestBytes: 2097152, requestsPerMinute: 120, maxConcurrentRequests: 24, maxConcurrentPerPrincipal: 4, requestTimeoutMs: 900000 },
    jobs: { embeddedRunnerEnabled: true },
    runnerControl: { enabled: false, credentials: [] },
    activeWorkspaceId: 'app',
    workspaces: [{ id: 'app', name: 'Application', root: workspaceRoot, mode: 'workspace-write', reference: false, role: 'active' }],
    commands: [],
    plugins: { enabled: [], settings: {} }
  };
  await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: root,
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });

  const rpc = async (method, params, authToken) => fetchJson(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${authToken}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
  const callTool = (name, arguments_, authToken) => rpc('tools/call', { name, arguments: arguments_ }, authToken);

  try {
    let ready = false;
    for (let index = 0; index < 40; index += 1) {
      await delay(250);
      try {
        const health = await fetchJson(`http://127.0.0.1:${port}/control/health`);
        if (health.response.ok && health.json?.instanceId === config.instanceId) {
          ready = true;
          break;
        }
      } catch {}
    }
    assert.equal(ready, true, `Gateway did not become ready.\nstdout=${stdout}\nstderr=${stderr}`);

    const ownerInit = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'team-e2e-owner', version: '1.0.0' }
    }, ownerToken);
    assert.equal(ownerInit.json?.result?.serverInfo?.name, 'devmate', `owner initialize failed: ${ownerInit.text}`);

    const created = await callTool('team_member_create', {
      name: 'E2E Developer', role: 'developer', workspaceIds: ['app']
    }, ownerToken);
    assertToolSuccess(created, 'team_member_create');
    const developerToken = structured(created)?.token;
    const developerId = structured(created)?.member?.id;
    assert.match(developerToken || '', /^dmt_/);
    assert.ok(developerId);

    const noLease = await callTool('create_file', {
      workspaceId: 'app', path: 'before-session.txt', content: 'blocked'
    }, developerToken);
    assertToolFailure(noLease, /requires a lease/i, 'write before session');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'before-session.txt')), false);

    const started = await callTool('work_session_start', {
      workspaceId: 'app', title: 'E2E session', purpose: 'business closure', ttlSeconds: 300
    }, developerToken);
    assertToolSuccess(started, 'work_session_start');
    const session = structured(started)?.session;
    assert.ok(session?.id);
    assert.ok(session?.leaseId);
    assert.equal(session.principalId, developerId);

    const write = await callTool('create_file', {
      workspaceId: 'app', path: 'during-session.txt', content: 'written under lease'
    }, developerToken);
    assertToolSuccess(write, 'create_file during session');
    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'during-session.txt'), 'utf8'), 'written under lease');

    const status = await callTool('work_session_status', { id: session.id }, developerToken);
    assertToolSuccess(status, 'work_session_status');
    assert.equal(structured(status)?.session?.id, session.id);
    assert.equal(structured(status)?.session?.lease?.id, session.leaseId);

    const dryRun = await callTool('work_session_rollback', { workSessionId: session.id, dryRun: true }, developerToken);
    assertToolSuccess(dryRun, 'work_session_rollback dry run');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'during-session.txt')), true);

    const finished = await callTool('work_session_finish', { id: session.id }, developerToken);
    assertToolSuccess(finished, 'work_session_finish');
    assert.equal(structured(finished)?.finished, true);
    assert.equal(structured(finished)?.lease?.released, true);

    const afterLease = await callTool('create_file', {
      workspaceId: 'app', path: 'after-session.txt', content: 'blocked again'
    }, developerToken);
    assertToolFailure(afterLease, /requires a lease/i, 'write after session');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'after-session.txt')), false);

    const noRollbackLease = await callTool('work_session_rollback', { workSessionId: session.id }, developerToken);
    assertToolFailure(noRollbackLease, /requires a lease/i, 'rollback without lease');

    const reacquired = await callTool('workspace_lease_acquire', {
      workspaceId: 'app', purpose: 'rollback finished session', ttlSeconds: 300
    }, developerToken);
    assertToolSuccess(reacquired, 'workspace_lease_acquire for rollback');

    const rollback = await callTool('work_session_rollback', { workSessionId: session.id }, developerToken);
    assertToolSuccess(rollback, 'work_session_rollback');
    assert.equal(fs.existsSync(path.join(workspaceRoot, 'during-session.txt')), false);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    }
    await fsp.rm(temp, { recursive: true, force: true });
  }
}, { timeout: 30000 });
