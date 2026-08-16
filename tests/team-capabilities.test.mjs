import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-team-cap-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
const config = configStore.newInstanceConfig({ workspaceRoot: temp, appVersion: configStore.DEFAULT_VERSION });
config.auth = { mode: 'oauth' };
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'app', role: 'active' };
config.team.requireWorkspaceLeaseForWrites = true;
configStore.atomicWriteJson(configPath, config);

const { __test: teamCapabilitiesTest, registerTeamTools, wrapAuthorizedTool } = await import('../gateway/team-capabilities.mjs');
const { runWithRequestContext } = await import('../gateway/request-context.mjs');
const { __test: teamToolDataTest } = await import('../gateway/team-tool-data.mjs');
const { drainAllAuditLogs } = await import('../gateway/audit-log-coordinator.mjs');
const { clearWorkspaceLeases } = await import('../gateway/workspace-leases.mjs');

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, toolConfig, handler) {
    this.tools.set(name, { config: toolConfig, handler: wrapAuthorizedTool(name, toolConfig, handler) });
  }
}

test('registers current instance, member, and lease capabilities', async () => {
  const server = new MockServer();
  registerTeamTools(server);
  server.registerTool('write_file', { annotations: { destructiveHint: true }, inputSchema: {} }, async () => ({ ok: true }));
  for (const name of ['deployment_status', 'deployment_readiness', 'team_member_create', 'workspace_lease_acquire']) assert.equal(server.tools.has(name), true);

  const created = await server.tools.get('team_member_create').handler({ name: 'Alice', role: 'developer', workspaceIds: ['app'] });
  const member = created.structuredContent.member;
  assert.match(created.structuredContent.loginCode, /^dmc_/);
  const principal = { id: member.id, name: member.name, role: member.role, workspaceIds: [...member.workspaceIds], source: 'oauth-member', authVersion: member.authVersion };

  await assert.rejects(runWithRequestContext({ principal }, () => server.tools.get('write_file').handler({ workspaceId: 'app' })), /requires a lease/);
  await runWithRequestContext({ principal }, () => server.tools.get('workspace_lease_acquire').handler({ workspaceId: 'app', ttlSeconds: 120 }));
  assert.equal((await runWithRequestContext({ principal }, () => server.tools.get('write_file').handler({ workspaceId: 'app' }))).ok, true);
});

test('Host allowlist is an explicit request capability independent of provider', () => {
  const current = { connection: { provider: 'external', publicUrl: 'https://devmate.example.com' }, requestPolicy: { allowedHosts: ['wrong.example.com'] } };
  assert.equal(teamToolDataTest.allowedPublicHost(current, { publicUrl: current.connection.publicUrl }), false);
  current.requestPolicy.allowedHosts = ['devmate.example.com'];
  assert.equal(teamToolDataTest.allowedPublicHost(current, { publicUrl: current.connection.publicUrl }), true);
  current.requestPolicy.allowedHosts = [];
  assert.equal(teamToolDataTest.allowedPublicHost(current, { publicUrl: current.connection.publicUrl }), true);
});

test('redacts command secrets from structured and text MCP results', () => {
  const raw = {
    command: 'tool --token top-secret --mode safe', exitCode: 0, timedOut: false,
    stdout: 'client_secret=client-value&mode=safe', stderr: 'Authorization: Bearer abc.def-123'
  };
  const result = { structuredContent: { result: { ...raw } }, content: [{ type: 'text', text: JSON.stringify({ result: raw }, null, 2) }] };
  teamCapabilitiesTest.sanitizeToolResult('run_command', result);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /top-secret|client-value|abc\.def-123/);
  assert.match(result.structuredContent.result.command, /--token=redacted/);
  assert.match(result.structuredContent.result.stdout, /client_secret=redacted&mode=safe/);
  assert.match(result.structuredContent.result.stderr, /Authorization: Bearer redacted/);
});

test('preserves independent JSON text payload semantics while redacting them', () => {
  const structured = { summary: 'keep', result: { command: 'tool --token structured-secret', exitCode: 0, stdout: 'ok', stderr: '' } };
  const partial = { part: { command: 'tool --token text-secret', exitCode: 0, stdout: 'ok', stderr: '' } };
  const result = { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(partial) }] };
  teamCapabilitiesTest.sanitizeToolResult('run_command', result);
  const text = JSON.parse(result.content[0].text);
  assert.deepEqual(Object.keys(text), ['part']);
  assert.equal(text.summary, undefined);
  assert.match(text.part.command, /--token=redacted/);
  assert.doesNotMatch(JSON.stringify(result), /structured-secret|text-secret/);
});

test('redacts persistent process output events without rewriting ordinary text', () => {
  const result = { structuredContent: { events: [{ text: 'owner_token=owner-value then ok' }] }, content: [{ type: 'text', text: 'process output ready' }] };
  teamCapabilitiesTest.sanitizeToolResult('read_process_output', result);
  assert.equal(result.structuredContent.events[0].text, 'owner_token=redacted then ok');
  assert.equal(result.content[0].text, 'process output ready');
});

test.after(async () => {
  clearWorkspaceLeases();
  await drainAllAuditLogs();
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
