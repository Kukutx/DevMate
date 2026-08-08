'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION, atomicWriteJson } = require('../shared/config-store.cjs');
const {
  mergeExtensionConfig,
  readExtensionConfig,
  writeExtensionConfig
} = require('../vscode-host/config-sync.js');

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-sync-'));
  return path.join(directory, 'config.json');
}

test('merges host-owned fields without replacing Gateway-owned state', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    server: { port: 8788, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner-token' },
    deployment: { mode: 'team', tunnelProvider: 'cloudflare-managed', publicUrl: 'https://team.example.com' },
    team: { enabled: true, requireWorkspaceLeaseForWrites: true, members: [{ id: 'alice' }] },
    production: { allowedHosts: ['team.example.com'], requestsPerMinute: 120 },
    runnerControl: { enabled: true },
    trustedWritableRoots: [{ id: 'trusted' }],
    runtime: { maxConcurrentJobs: 4, defaultCommandTimeoutMs: 1000 },
    workspaces: [{ id: 'app' }, { id: 'trusted', trusted: true, role: 'trusted' }]
  };
  const candidate = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stale',
    server: { port: 9999, mcpPath: '/mcp' },
    auth: { required: false, token: 'stale-token' },
    deployment: { mode: 'personal', tunnelProvider: 'ngrok', publicUrl: '' },
    team: { enabled: false, requireWorkspaceLeaseForWrites: false, members: [] },
    production: { allowedHosts: [], requestsPerMinute: 9999 },
    runtime: { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000 },
    workspaces: [{ id: 'app' }]
  };
  const merged = mergeExtensionConfig(current, candidate);
  assert.equal(merged.instanceId, 'stable');
  assert.deepEqual(merged.server, current.server);
  assert.equal(merged.auth.token, 'owner-token');
  assert.equal(merged.auth.required, false);
  assert.equal(merged.runtime.maxConcurrentJobs, 4);
  assert.equal(merged.runtime.defaultCommandTimeoutMs, 2000);
  assert.equal(merged.workspaces.some(item => item.id === 'trusted'), true);
  assert.deepEqual(merged.deployment, current.deployment);
  assert.deepEqual(merged.team, current.team);
  assert.deepEqual(merged.production, current.production);
});

test('partial extension updates preserve existing workspaces and shared business state', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    deployment: { mode: 'production', tunnelProvider: 'external', publicUrl: 'https://prod.example.com' },
    team: { enabled: true, members: [{ id: 'maintainer' }] },
    production: { allowedHosts: ['prod.example.com'] },
    workspaces: [
      { id: 'app', root: '/workspace/app' },
      { id: 'docs', root: '/workspace/docs', reference: true, mode: 'readonly' },
      { id: 'trusted', root: '/workspace/shared', trusted: true, role: 'trusted' }
    ]
  };
  const merged = mergeExtensionConfig(current, {
    version: SUPPORTED_CONFIG_VERSION,
    connection: { lastPreflightAt: 'now' }
  });
  assert.deepEqual(merged.workspaces, current.workspaces);
  assert.equal(merged.connection.lastPreflightAt, 'now');
  assert.deepEqual(merged.deployment, current.deployment);
  assert.deepEqual(merged.team, current.team);
  assert.deepEqual(merged.production, current.production);
});

test('pure merge never manufactures Gateway-owned nested state', () => {
  const merged = mergeExtensionConfig({}, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'new',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner-token', forgedPolicy: true },
    runtime: { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000, maxConcurrentJobs: 99 },
    deployment: { mode: 'production', tunnelProvider: 'external', publicUrl: 'https://forged.example.com' },
    team: {
      enabled: true,
      requireWorkspaceLeaseForWrites: true,
      members: [{ id: 'forged-member' }],
      forgedPolicy: true
    },
    production: { allowedHosts: ['forged.example.com'] },
    workspaces: [{ id: 'app' }, { id: 'forged', trusted: true, role: 'trusted' }],
    jobs: { embeddedRunnerEnabled: false },
    runnerControl: { enabled: true },
    plugins: { enabled: ['forged'] },
    trustedWritableRoots: [{ id: 'forged' }],
    hostRuntime: { owner: 'forged' }
  });
  assert.equal(merged.instanceId, 'new');
  assert.deepEqual(merged.server, { port: 8787, mcpPath: '/mcp' });
  assert.deepEqual(merged.auth, { required: true, token: 'owner-token' });
  assert.deepEqual(merged.runtime, { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000 });
  assert.deepEqual(merged.workspaces, [{ id: 'app' }]);
  for (const key of [
    'deployment', 'team', 'production', 'jobs', 'runnerControl', 'plugins',
    'trustedWritableRoots', 'hostRuntime'
  ]) {
    assert.equal(Object.hasOwn(merged, key), false, `${key} must remain shared/Gateway-owned`);
  }
});

test('generic VS Code writer refuses to recreate a missing shared config', () => {
  const file = tempFile();
  assert.throws(() => writeExtensionConfig(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'new-identity',
    auth: { required: true, token: 'new-token' },
    vscodeContext: { capturedAt: 'now' }
  }), error => error?.code === 'DEVMATE_SHARED_CONFIG_MISSING');
  assert.equal(fs.existsSync(file), false);
});

test('writes through the shared locked atomic store after shared initialization', () => {
  const file = tempFile();
  atomicWriteJson(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'one',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'secret' }
  });
  writeExtensionConfig(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stale',
    connection: { lastPreflightAt: 'now' }
  });
  const config = readExtensionConfig(file);
  assert.equal(config.instanceId, 'one');
  assert.equal(config.auth.token, 'secret');
  assert.equal(config.connection.lastPreflightAt, 'now');
});

test('rejects malformed and future configuration without replacement', () => {
  const malformed = tempFile();
  fs.writeFileSync(malformed, '{broken', 'utf8');
  assert.throws(() => writeExtensionConfig(malformed, { version: SUPPORTED_CONFIG_VERSION }),
    error => error.code === 'config_invalid_json');

  const future = tempFile();
  const original = `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION + 1 })}\n`;
  fs.writeFileSync(future, original, 'utf8');
  assert.throws(() => writeExtensionConfig(future, { version: SUPPORTED_CONFIG_VERSION }),
    error => error.code === 'unsupported_config_version');
  assert.equal(fs.readFileSync(future, 'utf8'), original);
});
