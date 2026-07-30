import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-approval-integration-'));
const configPath = path.join(temp, 'config.json');
await fsp.writeFile(configPath, JSON.stringify({
  instanceId: 'approval-integration',
  auth: { required: true, token: 'owner-token-value-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: { mode: 'production', tunnelProvider: 'external', publicUrl: 'https://devmate.example.com' },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: true },
  production: { allowedHosts: ['devmate.example.com'] },
  maintenance: { auditRetentionDays: 90 },
  activeWorkspaceId: 'app',
  workspaces: [{ id: 'app', name: 'app', root: temp, mode: 'workspace-write', reference: false }],
  plugins: { enabled: [], settings: {} }
}, null, 2));
process.env.DEVMATE_CONFIG = configPath;

const { installTeamCapabilities } = await import('../gateway/team-capabilities.mjs');
const { runWithRequestContext } = await import('../gateway/request-context.mjs');
const { clearApprovalRequests } = await import('../gateway/approvals.mjs');
const { clearWorkspaceLeases } = await import('../gateway/workspace-leases.mjs');

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
  async connect() { return 'ok'; }
}

installTeamCapabilities(MockServer);

const alice = { id: 'alice', name: 'Alice', role: 'maintainer', workspaceIds: ['app'], source: 'team-token' };
const bob = { id: 'bob', name: 'Bob', role: 'maintainer', workspaceIds: ['app'], source: 'team-token' };

test('requires dual control before executing a protected publish tool', async () => {
  const server = new MockServer();
  let executions = 0;
  server.registerTool('git_push', {
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async () => ({ content: [{ type: 'text', text: 'pushed' }], structuredContent: { pushed: true, executions: ++executions } }));
  await server.connect();

  await runWithRequestContext({ principal: alice }, () => server.tools.get('workspace_lease_acquire').handler({ workspaceId: 'app', ttlSeconds: 300 }));

  let approvalId;
  await assert.rejects(
    runWithRequestContext({ principal: alice }, () => server.tools.get('git_push').handler({ workspaceId: 'app', remote: 'origin', branch: 'main' })),
    error => {
      approvalId = error.approvalRequest?.id;
      return error.code === 'approval_required' && !!approvalId;
    }
  );
  assert.equal(executions, 0);

  await runWithRequestContext({ principal: bob }, () => server.tools.get('team_approval_decide').handler({
    id: approvalId,
    decision: 'approve',
    note: 'Reviewed release'
  }));

  const result = await runWithRequestContext({ principal: alice }, () => server.tools.get('git_push').handler({ workspaceId: 'app', remote: 'origin', branch: 'main' }));
  assert.equal(result.structuredContent.pushed, true);
  assert.equal(executions, 1);
});

test.after(async () => {
  clearApprovalRequests();
  clearWorkspaceLeases();
  await fsp.rm(temp, { recursive: true, force: true });
});
