import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-team-cap-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
await fsp.writeFile(configPath, JSON.stringify({
  version: 11,
  auth: { required: true, token: 'owner-token-value-long-enough' },
  permissions: { profile: 'fullAccess' },
  deployment: {
    mode: 'team',
    tunnelProvider: 'external',
    publicUrl: 'https://devmate.example.com'
  },
  team: { enabled: true, members: [], requireWorkspaceLeaseForWrites: true },
  production: {},
  maintenance: { auditRetentionDays: 90 },
  activeWorkspaceId: 'app',
  workspaces: [{
    id: 'app',
    name: 'app',
    root: temp,
    mode: 'workspace-write',
    reference: false
  }],
  plugins: { enabled: [], settings: {} }
}, null, 2));

const { installTeamCapabilities } = await import('../gateway/team-capabilities.mjs');
const { runWithRequestContext } = await import('../gateway/request-context.mjs');

class MockServer {
  constructor() {
    this.tools = new Map();
  }
  registerTool(name, config, handler) {
    this.tools.set(name, { config, handler });
  }
  async connect() {
    return 'ok';
  }
}

installTeamCapabilities(MockServer);

test('registers deployment, team, and lease tools', async () => {
  const server = new MockServer();
  server.registerTool(
    'write_file',
    { annotations: { destructiveHint: true }, inputSchema: {} },
    async () => ({ ok: true })
  );
  await server.connect();
  for (const name of [
    'deployment_status',
    'deployment_readiness',
    'team_member_create',
    'workspace_lease_acquire'
  ]) {
    assert.equal(server.tools.has(name), true);
  }

  const created = await server.tools.get('team_member_create').handler({
    name: 'Alice', role: 'developer', workspaceIds: ['app']
  });
  const member = created.structuredContent.member;
  const principal = {
    id: member.id,
    name: member.name,
    role: 'developer',
    workspaceIds: ['app'],
    source: 'team-token'
  };
  await assert.rejects(
    runWithRequestContext({ principal }, () =>
      server.tools.get('write_file').handler({ workspaceId: 'app' })
    ),
    /requires a lease/
  );
  await runWithRequestContext({ principal }, () =>
    server.tools.get('workspace_lease_acquire').handler({
      workspaceId: 'app', ttlSeconds: 120
    })
  );
  const result = await runWithRequestContext({ principal }, () =>
    server.tools.get('write_file').handler({ workspaceId: 'app' })
  );
  assert.equal(result.ok, true);
  await assert.rejects(
    runWithRequestContext({ principal }, () =>
      server.tools.get('team_member_list').handler({})
    ),
    /owner role/
  );
});

test.after(async () => fsp.rm(temp, { recursive: true, force: true }));
