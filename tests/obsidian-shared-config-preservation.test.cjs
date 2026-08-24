'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION, ensureInstanceConfig } = require('../shared/config-store.cjs');

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-config-'));
  return { root, configFile: path.join(root, '.state', 'config.json') };
}

test('shared host config completion preserves connection, access, policy, runners, plugins and identity', () => {
  const { root, configFile } = tempWorkspace();
  const original = {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion: '3.3.0',
    instanceId: 'shared-instance',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { mode: 'oauth' },
    connection: { provider: 'cloudflare-managed', publicUrl: 'https://team.example.com' },
    permissions: { profile: 'fullAccess', readOnly: false },
    team: {
      members: [{ id: 'alice', role: 'developer', workspaceIds: ['vault'] }],
      requireWorkspaceLeaseForWrites: true,
      defaultMemberRole: 'developer',
      maxMembers: 100,
      approvals: { enabled: true }
    },
    requestPolicy: { allowedHosts: ['team.example.com'] },
    jobs: { embeddedRunnerEnabled: false, allowJobGitSave: false },
    runnerControl: { enabled: true, credentials: [{ id: 'runner-1' }] },
    plugins: { enabled: ['godot'], settings: { godot: { enabled: true } } },
    activeWorkspaceId: 'vault',
    workspaces: [{ id: 'vault', name: 'vault', root, mode: 'workspace-write', reference: false, role: 'active' }]
  };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

  try {
    const result = ensureInstanceConfig({ configFile, workspaceRoot: root, preferredPort: 9999, appVersion: '3.3.0' });
    assert.deepEqual(result.connection, { ...original.connection, policyGeneration: 0 });
    assert.deepEqual(result.team.members, original.team.members);
    assert.equal(result.team.requireWorkspaceLeaseForWrites, true);
    assert.deepEqual(result.team.approvals, original.team.approvals);
    assert.deepEqual(result.requestPolicy.allowedHosts, ['team.example.com']);
    assert.deepEqual(result.jobs, original.jobs);
    assert.deepEqual(result.runnerControl, original.runnerControl);
    assert.deepEqual(result.plugins, original.plugins);
    assert.deepEqual(result.auth, { mode: 'oauth' });
    assert.equal(result.server.port, 8787, 'an existing shared Gateway port must not be replaced by a host preference');
    assert.equal(result.activeWorkspaceId, 'vault');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
