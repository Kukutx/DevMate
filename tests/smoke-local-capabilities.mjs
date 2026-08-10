import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const port = Number(process.env.DEVMATE_LOCAL_SMOKE_PORT || 8799);
const token = 'local-capabilities-smoke-token';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-local-smoke-'));
const trustedRoot = path.join(tempRoot, 'trusted');
fs.mkdirSync(trustedRoot, { recursive: true });
const configPath = path.join(tempRoot, 'config.json');
const gatewayScript = path.join(root, 'gateway', 'server.bundle.mjs');

fs.writeFileSync(configPath, JSON.stringify({
  version: 11,
  appVersion: '3.3.1',
  instanceId: `local-smoke-${Date.now()}`,
  server: { port, mcpPath: '/mcp' },
  runtime: { defaultCommandTimeoutMs: 30000, maxOutputChars: 80000 },
  maintenance: { backupRetentionDays: 30, auditRetentionDays: 30, maxBackupBytes: 268435456, maxAuditBytes: 5242880 },
  auth: { required: true, token },
  permissions: { profile: 'fullAccess', readOnly: false, blockDangerousOperations: false, confirmBeforePush: false, allowDirectoryMutations: true },
  activeWorkspaceId: 'devmate',
  workspaces: [{ id: 'devmate', name: 'devmate', root, mode: 'workspace-write', reference: false, role: 'active' }],
  trustedWritableRoots: [],
  commands: [],
  vscodeContext: { capturedAt: new Date().toISOString(), activeEditor: null, visibleEditors: [], diagnostics: [] },
  connection: {}
}, null, 2));

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

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }
async function stopGateway() {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    await delay(200);
    try {
      const result = await fetchJson(`http://127.0.0.1:${port}/control/health`);
      if (result.response.ok && result.json?.name === 'devmate') return;
    } catch {}
  }
  throw new Error(`Gateway did not become ready.\nstdout=${stdout}\nstderr=${stderr}`);
}
async function rpc(method, params) {
  return fetchJson(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 100000), method, params })
  });
}
function toolPayload(result) {
  const text = result.json?.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : result.json?.result?.structuredContent;
}
async function callTool(name, args = {}) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert(result.response.ok && !result.json?.error && result.json?.result?.isError !== true, `${name} failed: ${result.text}`);
  return toolPayload(result);
}

try {
  await waitReady();
  const init = await rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'devmate-local-smoke', version: '1.16.0' }
  });
  assert(init.response.ok && init.json?.result?.serverInfo?.name === 'devmate', `initialize failed: ${init.text}`);

  const tools = await rpc('tools/list', {});
  const names = new Set((tools.json?.result?.tools || []).map(tool => tool.name));
  for (const name of [
    'local_capabilities_status', 'configure_local_capabilities', 'list_trusted_roots',
    'add_trusted_root', 'remove_trusted_root', 'start_process', 'list_processes',
    'process_status', 'read_process_output', 'send_process_input', 'stop_process'
  ]) assert(names.has(name), `missing local capability tool ${name}`);

  const status = await callTool('local_capabilities_status');
  assert(status.permissionProfile === 'fullAccess', 'local capability status did not report fullAccess');

  const trusted = await callTool('add_trusted_root', { path: trustedRoot, name: 'smoke-trusted' });
  assert(trusted.added === true && trusted.root?.id, 'trusted root add failed');
  fs.writeFileSync(path.join(trustedRoot, 'server.cjs'), "console.log('persistent-ready'); setInterval(() => {}, 1000);\n");
  const command = `"${process.execPath.replace(/"/g, '\\"')}" server.cjs`;
  const started = await callTool('start_process', { workspaceId: trusted.root.id, command, label: 'smoke-process' });
  assert(started.started === true && started.process?.id, 'persistent process did not start');

  let output = null;
  for (let i = 0; i < 50; i++) {
    await delay(100);
    output = await callTool('read_process_output', { id: started.process.id, afterSequence: 0, maxChars: 20000 });
    if (output.events?.some(event => event.text.includes('persistent-ready'))) break;
  }
  assert(output?.events?.some(event => event.text.includes('persistent-ready')), `persistent output missing: ${JSON.stringify(output)}`);
  const stopped = await callTool('stop_process', { id: started.process.id, force: false });
  assert(stopped.stopped === true, `persistent process did not stop: ${JSON.stringify(stopped)}`);
  const removed = await callTool('remove_trusted_root', { id: trusted.root.id });
  assert(removed.removed === true, 'trusted root removal failed');

  console.log(JSON.stringify({ ok: true, toolCount: names.size, processId: started.process.id, trustedRootId: trusted.root.id }));
} finally {
  await stopGateway();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}