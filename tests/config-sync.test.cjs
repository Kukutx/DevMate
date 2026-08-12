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

test('merges host-owned fields without replacing shared capability state', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    server: { port: 8788, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner-token' },
    connection: { provider: 'cloudflare-managed', publicUrl: 'https://team.example.com', lastPreflightAt: 'current' },
    team: { requireWorkspaceLeaseForWrites: true, defaultMemberRole: 'developer', maxMembers: 100, members: [{ id: 'alice' }] },
    requestPolicy: { allowedHosts: ['team.example.com'], requestsPerMinute: 120 },
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
    connection: { provider: 'ngrok', publicUrl: '', lastPreflightAt: 'stale' },
    team: { requireWorkspaceLeaseForWrites: false, members: [] },
    requestPolicy: { allowedHosts: [], requestsPerMinute: 9999 },
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
  assert.deepEqual(merged.connection, current.connection);
  assert.deepEqual(merged.team, current.team);
  assert.deepEqual(merged.requestPolicy, current.requestPolicy);
});

test('partial extension updates preserve existing workspaces and shared connection', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    connection: { provider: 'external', publicUrl: 'https://prod.example.com', lastPreflightAt: 'verified' },
    team: { members: [{ id: 'maintainer' }], requireWorkspaceLeaseForWrites: true },
    requestPolicy: { allowedHosts: ['prod.example.com'] },
    workspaces: [
      { id: 'app', root: '/workspace/app' },
      { id: 'docs', root: '/workspace/docs', reference: true, mode: 'readonly' },
      { id: 'trusted', root: '/workspace/shared', trusted: true, role: 'trusted' }
    ]
  };
  const merged = mergeExtensionConfig(current, {
    version: SUPPORTED_CONFIG_VERSION,
    connection: { provider: 'ngrok', publicUrl: '', lastPreflightAt: 'stale-candidate' },
    hostContexts: { vscode: { capturedAt: 'now' } }, activeHostId: 'vscode'
  });
  assert.deepEqual(merged.workspaces, current.workspaces);
  assert.deepEqual(merged.connection, current.connection);
  assert.deepEqual(merged.team, current.team);
  assert.deepEqual(merged.requestPolicy, current.requestPolicy);
  assert.deepEqual(merged.hostContexts.vscode, { capturedAt: 'now' });
  assert.equal(merged.activeHostId, 'vscode');
  assert.equal(Object.hasOwn(merged, 'vscodeContext'), false);
});

test('pure merge never manufactures shared nested state', () => {
  const merged = mergeExtensionConfig({}, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'new',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner-token', forgedPolicy: true },
    runtime: { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000, maxConcurrentJobs: 99 },
    connection: { provider: 'external', publicUrl: 'https://forged.example.com' },
    team: { requireWorkspaceLeaseForWrites: true, members: [{ id: 'forged-member' }], forgedPolicy: true },
    requestPolicy: { allowedHosts: ['forged.example.com'] },
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
    'connection', 'team', 'requestPolicy', 'jobs', 'runnerControl', 'plugins',
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
    hostContexts: { vscode: { capturedAt: 'now' } }, activeHostId: 'vscode'
  }), error => error?.code === 'DEVMATE_SHARED_CONFIG_MISSING');
  assert.equal(fs.existsSync(file), false);
});

test('writes host context through the shared locked atomic store without replacing connection', () => {
  const file = tempFile();
  atomicWriteJson(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'one',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'secret' },
    connection: { provider: 'external', publicUrl: 'https://current.example.com', lastPreflightAt: 'current' }
  });
  writeExtensionConfig(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stale',
    connection: { provider: 'ngrok', publicUrl: '', lastPreflightAt: 'stale' },
    hostContexts: { vscode: { capturedAt: 'now' } }, activeHostId: 'vscode'
  });
  const config = readExtensionConfig(file);
  assert.equal(config.instanceId, 'one');
  assert.equal(config.auth.token, 'secret');
  assert.deepEqual(config.connection, { provider: 'external', publicUrl: 'https://current.example.com', lastPreflightAt: 'current' });
  assert.deepEqual(config.hostContexts.vscode, { capturedAt: 'now' });
  assert.equal(config.activeHostId, 'vscode');
  assert.equal(Object.hasOwn(config, 'vscodeContext'), false);
});

test('VS Code config boundary rejects unsupported instance fields instead of preserving them', () => {
  const file = tempFile();
  atomicWriteJson(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'old-shape',
    deployment: { mode: 'team' },
    connection: { provider: 'ngrok', publicUrl: '' }
  });
  assert.throws(() => readExtensionConfig(file), error => error?.code === 'unsupported_instance_shape');
  assert.throws(() => writeExtensionConfig(file, {
    version: SUPPORTED_CONFIG_VERSION,
    hostContexts: { vscode: { capturedAt: 'now' } }, activeHostId: 'vscode'
  }), error => error?.code === 'unsupported_instance_shape');
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
