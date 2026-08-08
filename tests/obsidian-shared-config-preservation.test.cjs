'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SUPPORTED_CONFIG_VERSION,
  ensurePersonalConfig
} = require('../shared/config-store.cjs');

function tempWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-config-'));
  return { root, configFile: path.join(root, '.state', 'config.json') };
}

test('shared host config completion preserves team deployment, members, runners, and provider state', () => {
  const { root, configFile } = tempWorkspace();
  const original = {
    version: SUPPORTED_CONFIG_VERSION,
    appVersion: '3.3.0',
    instanceId: 'shared-instance',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'shared-owner-token' },
    deployment: {
      mode: 'team',
      tunnelProvider: 'cloudflare-managed',
      publicUrl: 'https://team.example.com'
    },
    team: {
      enabled: true,
      members: [{ id: 'alice', role: 'developer', workspaceIds: ['vault'] }],
      requireWorkspaceLeaseForWrites: true,
      approvals: { enabled: true }
    },
    production: { allowedHosts: ['team.example.com'] },
    jobs: { embeddedRunnerEnabled: false, allowJobGitSave: false },
    runnerControl: { enabled: true, credentials: [{ id: 'runner-1' }] },
    plugins: { enabled: ['godot'], settings: { godot: { enabled: true } } },
    activeWorkspaceId: 'vault',
    workspaces: [{
      id: 'vault',
      name: 'vault',
      root,
      mode: 'workspace-write',
      reference: false,
      role: 'active'
    }]
  };
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, `${JSON.stringify(original, null, 2)}\n`, 'utf8');

  try {
    const result = ensurePersonalConfig({
      configFile,
      workspaceRoot: root,
      preferredPort: 9999,
      appVersion: '3.3.0'
    });
    assert.deepEqual(result.deployment, original.deployment);
    assert.deepEqual(result.team, original.team);
    assert.deepEqual(result.production, original.production);
    assert.deepEqual(result.jobs, original.jobs);
    assert.deepEqual(result.runnerControl, original.runnerControl);
    assert.deepEqual(result.plugins, original.plugins);
    assert.equal(result.auth.token, original.auth.token);
    assert.equal(result.server.port, 8787, 'an existing shared Gateway port must not be replaced by a host preference');
    assert.equal(result.activeWorkspaceId, 'vault');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
