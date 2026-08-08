'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const {
  applyDeploymentPatch,
  readDeploymentConfig
} = require('../vscode-host/shared-deployment-config.js');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shared-deployment-'));
  const file = path.join(directory, 'config.json');
  const config = {
    version: 11,
    appVersion: '3.3.0',
    instanceId: 'shared',
    server: { port: 8787, mcpPath: '/mcp' },
    auth: { required: true, token: 'owner' },
    deployment: { mode: 'team', tunnelProvider: 'external', publicUrl: 'https://old.example.com' },
    team: {
      enabled: true,
      members: [{ id: 'alice', role: 'developer', workspaceIds: ['app'] }],
      requireWorkspaceLeaseForWrites: true,
      approvals: { enabled: true, requiredCapabilities: ['publish'] }
    },
    production: {
      maxRequestBytes: 2097152,
      requestsPerMinute: 600,
      maxConcurrentRequests: 64,
      maxConcurrentPerPrincipal: 16,
      requestTimeoutMs: 900000,
      allowedHosts: ['manual.example.com']
    },
    jobs: { embeddedRunnerEnabled: false },
    runnerControl: { enabled: true, credentials: [{ id: 'runner-1' }] },
    plugins: { enabled: ['godot'], settings: {} },
    workspaces: [{ id: 'app', root: directory, mode: 'workspace-write' }]
  };
  atomicWriteJson(file, config);
  return { directory, file, config };
}

test('deployment patch changes only requested business fields and preserves team identities and runtime control state', () => {
  const { directory, file, config } = fixture();
  try {
    const result = applyDeploymentPatch(file, {
      mode: 'production',
      tunnelProvider: 'cloudflare-managed',
      publicUrl: 'https://prod.example.com',
      allowedHosts: ['prod.example.com']
    });
    assert.deepEqual(result.deployment, {
      mode: 'production',
      tunnelProvider: 'cloudflare-managed',
      publicUrl: 'https://prod.example.com'
    });
    assert.deepEqual(result.team.members, config.team.members);
    assert.deepEqual(result.team.approvals, config.team.approvals);
    assert.deepEqual(result.jobs, config.jobs);
    assert.deepEqual(result.runnerControl, config.runnerControl);
    assert.deepEqual(result.plugins, config.plugins);
    assert.equal(result.production.requestsPerMinute, 600);
    assert.deepEqual(result.production.allowedHosts, ['prod.example.com']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('one production limit update does not rewrite unrelated production policy', () => {
  const { directory, file } = fixture();
  try {
    const before = readDeploymentConfig(file).config.production;
    const result = applyDeploymentPatch(file, { requestsPerMinute: 777 });
    assert.equal(result.production.requestsPerMinute, 777);
    assert.equal(result.production.maxRequestBytes, before.maxRequestBytes);
    assert.equal(result.production.maxConcurrentRequests, before.maxConcurrentRequests);
    assert.equal(result.production.maxConcurrentPerPrincipal, before.maxConcurrentPerPrincipal);
    assert.equal(result.production.requestTimeoutMs, before.requestTimeoutMs);
    assert.deepEqual(result.production.allowedHosts, before.allowedHosts);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid production quick tunnel transition is rejected atomically', () => {
  const { directory, file } = fixture();
  try {
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => applyDeploymentPatch(file, {
      mode: 'production',
      tunnelProvider: 'cloudflare-quick',
      publicUrl: ''
    }), /cannot be used in production/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('managed and production deployment transitions require a clean stable HTTPS URL', () => {
  const { directory, file } = fixture();
  try {
    assert.throws(() => applyDeploymentPatch(file, {
      mode: 'production',
      tunnelProvider: 'external',
      publicUrl: ''
    }), /requires a stable public HTTPS URL/);
    assert.throws(() => applyDeploymentPatch(file, {
      mode: 'team',
      tunnelProvider: 'cloudflare-managed',
      publicUrl: ''
    }), /requires a stable public HTTPS URL/);
    assert.throws(() => applyDeploymentPatch(file, {
      mode: 'production',
      tunnelProvider: 'external',
      publicUrl: 'http://unsafe.example.com'
    }), /clean HTTPS origin/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
