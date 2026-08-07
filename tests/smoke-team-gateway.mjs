import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.DEVMATE_TEAM_SMOKE_PORT || 8801);
const ownerToken = 'team-smoke-owner-token';
const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-team-smoke-'));
const workspaceRoot = path.join(temp, 'workspace');
const configPath = path.join(temp, 'config.json');
const bundledGateway = path.join(root, 'gateway', 'server.bundle.mjs');
const gatewayScript = process.env.DEVMATE_GATEWAY_SCRIPT || (fs.existsSync(bundledGateway) ? 'gateway/server.bundle.mjs' : 'gateway/server.mjs');
await fsp.mkdir(workspaceRoot, { recursive: true });

const config = {
  version: 11,
  appVersion: '3.3.0',
  instanceId: `team-smoke-${Date.now()}`,
  server: { port, mcpPath: '/mcp' },
  runtime: { defaultCommandTimeoutMs: 30000, maxOutputChars: 80000 },
  maintenance: {
    backupRetentionDays: 30,
    auditRetentionDays: 30,
    maxBackupBytes: 268435456,
    maxAuditBytes: 5242880
  },
  auth: { required: true, token: ownerToken },
  permissions: {
    profile: 'fullAccess',
    readOnly: false,
    blockDangerousOperations: true,
    confirmBeforePush: true,
    allowDirectoryMutations: false
  },
  deployment: {
    mode: 'team',
    tunnelProvider: 'external',
    publicUrl: 'https://team-smoke.example.com'
  },
  team: {
    enabled: true,
    members: [],
    requireWorkspaceLeaseForWrites: true,
    approvals: { enabled: false, requiredCapabilities: [], requiredTools: [], separationOfDuties: true }
  },
  production: {
    allowedHosts: [],
    maxRequestBytes: 2097152,
    requestsPerMinute: 120,
    maxConcurrentRequests: 24,
    maxConcurrentPerPrincipal: 4,
    requestTimeoutMs: 900000
  },
  jobs: { embeddedRunnerEnabled: true },
  runnerControl: { enabled: false, credentials: [] },
  activeWorkspaceId: 'app',
  workspaces: [{
    id: 'app',
    name: 'Application',
    root: workspaceRoot,
    mode: 'workspace-write',
    reference: false,
    role: 'active'
  }],
  commands: [],
  plugins: { enabled: [], settings: {} }
};
await fsp.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

const child = spawn(process.execPath, [gatewayScript], {
  cwd: root,
  env: { ...process.env, DEVMATE_CONFIG: configPath },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; });
child.stderr.on('data', chunk => { stderr += chunk; });

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function stopGateway() {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000)
  ]);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    await delay(250);
    try {
      const result = await fetchJson(`http://127.0.0.1:${port}/control/health`);
      if (result.response.ok && result.json?.instanceId === config.instanceId) return;
    } catch {}
  }
  throw new Error(`Team Gateway did not become ready.\nstdout=${stdout}\nstderr=${stderr}`);
}

async function rpc(method, params, authToken) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${authToken}`
  };
  return fetchJson(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 100000),
      method,
      params
    })
  });
}

async function callTool(name, arguments_, authToken) {
  return rpc('tools/call', { name, arguments: arguments_ }, authToken);
}

function structured(result) {
  return result.json?.result?.structuredContent || null;
}

function assertToolSuccess(result, label) {
  assert(result.response.ok, `${label} HTTP failed: ${result.text}`);
  assert(!result.json?.error, `${label} RPC failed: ${result.text}`);
  assert(result.json?.result?.isError !== true, `${label} tool failed: ${result.text}`);
}

function assertToolFailure(result, pattern, label) {
  const failed = !!result.json?.error || result.json?.result?.isError === true;
  assert(failed, `${label} unexpectedly succeeded: ${result.text}`);
  assert(pattern.test(result.text), `${label} failed for the wrong reason: ${result.text}`);
}

try {
  await waitReady();

  const ownerInit = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'devmate-team-owner-smoke', version: '1.0.0' }
  }, ownerToken);
  assert(ownerInit.response.ok && ownerInit.json?.result?.serverInfo?.name === 'devmate', `owner initialize failed: ${ownerInit.text}`);

  const created = await callTool('team_member_create', {
    name: 'Team Smoke Developer',
    role: 'developer',
    workspaceIds: ['app']
  }, ownerToken);
  assertToolSuccess(created, 'team_member_create');
  const developerToken = structured(created)?.token;
  const developerId = structured(created)?.member?.id;
  assert(/^dmt_/.test(developerToken || ''), `team member token missing: ${created.text}`);
  assert(developerId, `team member id missing: ${created.text}`);

  const developerInit = await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'devmate-team-developer-smoke', version: '1.0.0' }
  }, developerToken);
  assert(developerInit.response.ok && developerInit.json?.result?.serverInfo?.name === 'devmate', `developer initialize failed: ${developerInit.text}`);

  const beforeLease = await callTool('create_file', {
    workspaceId: 'app',
    path: 'before-session.txt',
    content: 'must not be written'
  }, developerToken);
  assertToolFailure(beforeLease, /requires a lease/i, 'write before work session');
  assert(!fs.existsSync(path.join(workspaceRoot, 'before-session.txt')), 'write without lease created a file');

  const started = await callTool('team_work_session_start', {
    workspaceId: 'app',
    title: 'Team smoke session',
    purpose: 'Verify the real team authorization and lease lifecycle',
    ttlSeconds: 300
  }, developerToken);
  assertToolSuccess(started, 'team_work_session_start');
  const session = structured(started)?.session;
  assert(session?.id && session?.leaseId, `work session did not return lease identity: ${started.text}`);
  assert(session.principalId === developerId, `work session principal mismatch: ${started.text}`);

  const write = await callTool('create_file', {
    workspaceId: 'app',
    path: 'during-session.txt',
    content: 'team session write succeeded'
  }, developerToken);
  assertToolSuccess(write, 'create_file during work session');
  assert(fs.readFileSync(path.join(workspaceRoot, 'during-session.txt'), 'utf8') === 'team session write succeeded', 'team session write content mismatch');

  const status = await callTool('team_work_session_status', { workspaceId: 'app' }, developerToken);
  assertToolSuccess(status, 'team_work_session_status');
  const sessions = structured(status)?.sessions || [];
  assert(sessions.some(item => item.id === session.id && item.lease?.id === session.leaseId), `active work session/lease missing from status: ${status.text}`);

  const finished = await callTool('team_work_session_finish', { id: session.id }, developerToken);
  assertToolSuccess(finished, 'team_work_session_finish');
  assert(structured(finished)?.finished === true, `work session did not finish: ${finished.text}`);
  assert(structured(finished)?.lease?.released === true, `work session did not release its lease: ${finished.text}`);

  const statusAfter = await callTool('team_work_session_status', { workspaceId: 'app' }, developerToken);
  assertToolSuccess(statusAfter, 'team_work_session_status after finish');
  assert((structured(statusAfter)?.sessions || []).every(item => item.id !== session.id), `finished session still appears active: ${statusAfter.text}`);

  const afterLease = await callTool('create_file', {
    workspaceId: 'app',
    path: 'after-session.txt',
    content: 'must not be written'
  }, developerToken);
  assertToolFailure(afterLease, /requires a lease/i, 'write after work session');
  assert(!fs.existsSync(path.join(workspaceRoot, 'after-session.txt')), 'write after lease release created a file');

  console.log('Team Gateway business-flow smoke passed.');
} catch (error) {
  console.error(error?.stack || error);
  console.error(`stdout=${stdout}`);
  console.error(`stderr=${stderr}`);
  process.exitCode = 1;
} finally {
  await stopGateway();
  await fsp.rm(temp, { recursive: true, force: true });
}
