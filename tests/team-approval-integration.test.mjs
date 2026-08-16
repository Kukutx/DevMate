import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-approval-integration-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
const config = configStore.newInstanceConfig({ workspaceRoot: temp, appVersion: configStore.DEFAULT_VERSION });
config.auth = { mode: 'oauth' };
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces[0] = { ...config.workspaces[0], id: 'app', name: 'app', role: 'active' };
config.team.requireWorkspaceLeaseForWrites = true;
config.team.approvals = { ...config.team.approvals, enabled: true, requiredCapabilities: ['publish'], separationOfDuties: true };
const teamAccess = await import('../gateway/team-access.mjs');
const aliceCreated = teamAccess.createTeamMember(config, { id: 'alice', name: 'Alice', role: 'maintainer', workspaceIds: ['app'] });
const bobCreated = teamAccess.createTeamMember(config, { id: 'bob', name: 'Bob', role: 'maintainer', workspaceIds: ['app'] });
configStore.atomicWriteJson(configPath, config);
const alice = teamAccess.verifyMemberLoginCode(aliceCreated.loginCode, config);
const bob = teamAccess.verifyMemberLoginCode(bobCreated.loginCode, config);

const { registerTeamTools, wrapAuthorizedTool } = await import('../gateway/team-capabilities.mjs');
const { runWithRequestContext } = await import('../gateway/request-context.mjs');
const { clearApprovalRequests } = await import('../gateway/approvals.mjs');
const { clearWorkspaceLeases } = await import('../gateway/workspace-leases.mjs');
const { drainAllAuditLogs } = await import('../gateway/audit-log-coordinator.mjs');

class MockServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, toolConfig, handler) {
    this.tools.set(name, { config: toolConfig, handler: wrapAuthorizedTool(name, toolConfig, handler) });
  }
}

test('requires dual control before executing a protected publish tool', async () => {
  const server = new MockServer();
  registerTeamTools(server);
  let executions = 0;
  server.registerTool('git_push', {
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async () => ({ structuredContent: { pushed: true, executions: ++executions } }));

  await runWithRequestContext({ principal: alice }, () => server.tools.get('workspace_lease_acquire').handler({ workspaceId: 'app', ttlSeconds: 300 }));
  let approvalId;
  await assert.rejects(
    runWithRequestContext({ principal: alice }, () => server.tools.get('git_push').handler({ workspaceId: 'app', remote: 'origin', branch: 'main' })),
    error => {
      approvalId = error.approvalRequest?.id;
      return error.code === 'approval_required' && !!approvalId;
    }
  );
  await runWithRequestContext({ principal: bob }, () => server.tools.get('team_approval_decide').handler({ id: approvalId, decision: 'approve', note: 'Reviewed release' }));
  const result = await runWithRequestContext({ principal: alice }, () => server.tools.get('git_push').handler({ workspaceId: 'app', remote: 'origin', branch: 'main' }));
  assert.equal(result.structuredContent.pushed, true);
  assert.equal(executions, 1);
});

test.after(async () => {
  clearApprovalRequests();
  clearWorkspaceLeases();
  await drainAllAuditLogs();
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
