import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const MCP_PROTOCOL_VERSION = '2026-07-28';

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitReady(port, child, output) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Gateway exited early: ${output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/control/health`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Gateway did not become ready: ${output()}`);
}

function requestMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'server-hardening-e2e', version: configStore.DEFAULT_VERSION },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

function rpcClient(port) {
  let id = 0;
  return async (method, params = {}) => {
    const name = method === 'tools/call' ? String(params?.name || '') : '';
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
        'mcp-method': method,
        ...(name ? { 'mcp-name': name } : {})
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method,
        params: { ...params, _meta: requestMeta() }
      })
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { response, text, json, data: json?.result?.structuredContent };
  };
}

function assertToolSuccess(result, label) {
  assert.equal(result.response.ok, true, `${label} HTTP failed: ${result.text}`);
  assert.equal(result.json?.error, undefined, `${label} RPC failed: ${result.text}`);
  assert.notEqual(result.json?.result?.isError, true, `${label} tool failed: ${result.text}`);
}

function assertToolError(result, label) {
  assert.equal(result.response.ok, true, `${label} HTTP failed: ${result.text}`);
  assert.equal(result.json?.error, undefined, `${label} RPC failed: ${result.text}`);
  assert.equal(result.json?.result?.isError, true, `${label} unexpectedly succeeded: ${result.text}`);
}

test('Gateway deep hardening protects secrets, readiness evidence, stable start time, and work-session failures', async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-server-hardening-'));
  const workspace = path.join(temp, 'workspace');
  const outside = path.join(temp, 'outside');
  const configPath = path.join(temp, 'config.json');
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.writeFile(path.join(workspace, 'credentials.json'), '{"token":"must-not-leak"}\n', 'utf8');
  await fsp.mkdir(path.join(workspace, 'credentials'), { recursive: true });
  await fsp.writeFile(path.join(workspace, 'credentials', 'secret.txt'), 'hidden-needle\n', 'utf8');
  await fsp.writeFile(path.join(workspace, 'MixedCase.txt'), 'NeedleToken\n', 'utf8');
  await fsp.writeFile(path.join(workspace, 'Player.gd'), 'extends Node\nconst GODOT_NEEDLE = "godot-text-needle"\n', 'utf8');
  await fsp.writeFile(path.join(workspace, 'scene.tscn'), '[gd_scene format=3]\n', 'utf8');
  const binaryAsset = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
  await fsp.writeFile(path.join(workspace, 'image.png'), binaryAsset);
  await fsp.mkdir(path.join(workspace, '.godot'), { recursive: true });
  await fsp.writeFile(path.join(workspace, '.godot', 'internal.cfg'), 'cache-secret-needle\n', 'utf8');
  await fsp.writeFile(path.join(outside, 'outside-agents.md'), 'outside-instruction-secret\n', 'utf8');

  let directoryAliasCreated = false;
  try {
    await fsp.symlink(
      path.join(workspace, 'credentials'),
      path.join(workspace, 'safe-alias'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    directoryAliasCreated = true;
  } catch {}

  let outsideInstructionAliasCreated = false;
  try {
    await fsp.symlink(path.join(outside, 'outside-agents.md'), path.join(workspace, 'AGENTS.md'), 'file');
    outsideInstructionAliasCreated = true;
  } catch {}

  const port = await freePort();
  const config = configStore.newInstanceConfig({ workspaceRoot: workspace, port, appVersion: configStore.DEFAULT_VERSION });
  // This test exercises trusted loopback hardening, not public OAuth. Keep that
  // boundary explicit so low-level config construction does not masquerade as a
  // production OAuth bootstrap (which also initializes dedicated secret state).
  config.auth.mode = 'none';
  config.activeWorkspaceId = 'app';
  config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'Application', role: 'active' };
  config.connection = {
    ...config.connection,
    lastPreflightAt: new Date().toISOString(),
    lastPublicHost: 'stale.example.com',
    lastMcpPath: '/mcp',
    lastToolCount: 100,
    lastServerName: 'devmate',
    lastToolCallVerified: false,
    lastProbeTool: ''
  };
  config.commands = [{
    key: 'secret-command',
    label: 'Secret command',
    readOnly: true,
    command: 'node script.mjs --token top-secret-configured-command'
  }];
  configStore.atomicWriteJson(configPath, config);

  const child = spawn(process.execPath, ['gateway/server-runtime.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, DEVMATE_CONFIG: configPath },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) await Promise.race([exited, delay(3000)]);
    await fsp.rm(temp, { recursive: true, force: true });
  });

  await waitReady(port, child, () => `${stdout}\n${stderr}`);
  const rpc = rpcClient(port);
  const discovery = await rpc('server/discover');
  assert.equal(discovery.response.ok, true, discovery.text);
  assert.ok(discovery.json?.result?.supportedVersions?.includes(MCP_PROTOCOL_VERSION), discovery.text);
  assert.equal(typeof discovery.json?.result?.capabilities, 'object', discovery.text);

  const firstGateway = await rpc('tools/call', { name: 'gateway_status', arguments: {} });
  assertToolSuccess(firstGateway, 'gateway_status first');
  await delay(30);
  const secondGateway = await rpc('tools/call', { name: 'gateway_status', arguments: {} });
  assertToolSuccess(secondGateway, 'gateway_status second');
  assert.equal(secondGateway.data?.startedAt, firstGateway.data?.startedAt, 'gateway startedAt must describe process start, not call time');

  const diagnostics = await rpc('tools/call', { name: 'connection_diagnostics', arguments: {} });
  assertToolSuccess(diagnostics, 'connection_diagnostics');
  assert.equal(diagnostics.data?.status, 'attention');
  assert.equal(diagnostics.data?.connection?.lastToolCallVerified, false);
  assert.ok(diagnostics.data?.advice?.some(value => /verified DevMate tool call/.test(value)), diagnostics.text);

  const configured = await rpc('tools/call', { name: 'list_configured_commands', arguments: {} });
  assertToolSuccess(configured, 'list_configured_commands');
  const exposedCommand = configured.data?.commands?.[0]?.command || '';
  assert.doesNotMatch(exposedCommand, /top-secret-configured-command/);
  assert.match(exposedCommand, /redacted/);

  const credentialsRead = await rpc('tools/call', { name: 'read_file', arguments: { workspaceId: 'app', path: 'credentials.json' } });
  assertToolError(credentialsRead, 'credentials.json read');
  assert.doesNotMatch(credentialsRead.text, /must-not-leak/);

  if (directoryAliasCreated) {
    const aliasSearch = await rpc('tools/call', {
      name: 'search_text',
      arguments: { workspaceId: 'app', subpath: 'safe-alias', query: 'hidden-needle' }
    });
    assertToolError(aliasSearch, 'hidden directory symlink search');
    assert.doesNotMatch(aliasSearch.text, /hidden-needle/);
  }

  const literalSearch = await rpc('tools/call', {
    name: 'search_text',
    arguments: { workspaceId: 'app', query: 'needletoken' }
  });
  assertToolSuccess(literalSearch, 'case-insensitive literal search');
  assert.ok(literalSearch.data?.results?.some(item => item.file === 'MixedCase.txt'), literalSearch.text);

  const godotRead = await rpc('tools/call', { name: 'read_file', arguments: { workspaceId: 'app', path: 'Player.gd' } });
  assertToolSuccess(godotRead, 'GDScript read');
  assert.match(godotRead.data?.text || '', /godot-text-needle/);

  const godotSearch = await rpc('tools/call', {
    name: 'search_text',
    arguments: { workspaceId: 'app', query: 'godot-text-needle' }
  });
  assertToolSuccess(godotSearch, 'GDScript search');
  assert.ok(godotSearch.data?.results?.some(item => item.file === 'Player.gd'), godotSearch.text);

  const fileList = await rpc('tools/call', {
    name: 'list_files',
    arguments: { workspaceId: 'app', subpath: '.', depth: 2, maxResults: 200 }
  });
  assertToolSuccess(fileList, 'Godot file listing');
  const listedPaths = fileList.data?.items?.map(item => item.path) || [];
  assert.ok(listedPaths.includes('Player.gd'), fileList.text);
  assert.ok(listedPaths.includes('scene.tscn'), fileList.text);
  assert.equal(listedPaths.some(item => item.startsWith('.godot/')), false, fileList.text);

  const godotWrite = await rpc('tools/call', {
    name: 'apply_patch',
    arguments: { workspaceId: 'app', path: 'Player.gd', oldText: 'godot-text-needle', newText: 'godot-text-updated' }
  });
  assertToolSuccess(godotWrite, 'GDScript patch');
  assert.match(await fsp.readFile(path.join(workspace, 'Player.gd'), 'utf8'), /godot-text-updated/);

  const binaryWrite = await rpc('tools/call', {
    name: 'write_file',
    arguments: { workspaceId: 'app', path: 'image.png', content: 'not-a-png' }
  });
  assertToolError(binaryWrite, 'binary write protection');
  assert.deepEqual(await fsp.readFile(path.join(workspace, 'image.png')), binaryAsset);

  const binaryPatch = await rpc('tools/call', {
    name: 'apply_patch',
    arguments: { workspaceId: 'app', path: 'image.png', oldText: 'PNG', newText: 'BAD' }
  });
  assertToolError(binaryPatch, 'binary patch protection');
  assert.deepEqual(await fsp.readFile(path.join(workspace, 'image.png')), binaryAsset);

  const binaryCreate = await rpc('tools/call', {
    name: 'create_file',
    arguments: { workspaceId: 'app', path: 'new-image.png', content: 'not-a-png' }
  });
  assertToolError(binaryCreate, 'binary create protection');
  assert.equal(fs.existsSync(path.join(workspace, 'new-image.png')), false);

  if (outsideInstructionAliasCreated) {
    const instructions = await rpc('tools/call', { name: 'project_instructions', arguments: { workspaceId: 'app' } });
    assertToolSuccess(instructions, 'project_instructions');
    assert.equal(instructions.data?.instructions?.loaded?.some(item => /outside-instruction-secret/.test(item.text || '')), false);
  }

  const sessionStart = await rpc('tools/call', {
    name: 'work_session_start',
    arguments: { workspaceId: 'app', title: 'failure counter', ttlSeconds: 300 }
  });
  assertToolSuccess(sessionStart, 'work_session_start');
  const sessionId = sessionStart.data?.session?.id;
  assert.ok(sessionId);

  const gitFailure = await rpc('tools/call', { name: 'git_status', arguments: { workspaceId: 'app' } });
  assertToolError(gitFailure, 'git_status in non-repository workspace');

  const sessionStatus = await rpc('tools/call', { name: 'work_session_status', arguments: { id: sessionId } });
  assertToolSuccess(sessionStatus, 'work_session_status');
  assert.equal(sessionStatus.data?.session?.failures, 1, sessionStatus.text);
  assert.ok(sessionStatus.data?.session?.toolCalls >= 1, sessionStatus.text);
}, { timeout: 30000 });

test('status panel keeps complete HTML entity escaping', async () => {
  const source = await fsp.readFile(new URL('../gateway/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /'"':'&quot;'/, 'double quotes must use the complete &quot; entity');
  assert.doesNotMatch(source, /'"':'&quot'(?=,)/, 'unterminated &quot entity regression');
});

test('server package scripts execute through explicit package-manager argv', async () => {
  const source = await fsp.readFile(new URL('../gateway/server.mjs', import.meta.url), 'utf8');
  assert.match(source, /const command = `\$\{pm\} run \$\{script\}`/);
  assert.match(source, /execProcess\(pm,\['run',script\],\{cwd:dir,\.\.\.limits,shell:false\}\)/);
  assert.match(source, /const command = `\$\{pm\} run \$\{name\}`/);
});