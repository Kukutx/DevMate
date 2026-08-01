'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  installConfigWriteInterceptor,
  mergeExtensionConfig,
  recoverReplacement
} = require('../extension-config-io');

test('preserves Gateway-owned config while applying VS Code-owned fields', () => {
  const current = {
    instanceId: 'stable-instance',
    appVersion: '2.9.0',
    auth: { required: true, token: 'current-owner-token' },
    runtime: { maxConcurrentJobs: 4, defaultCommandTimeoutMs: 1000 },
    team: {
      enabled: true,
      requireWorkspaceLeaseForWrites: true,
      members: [{ id: 'alice' }],
      approvals: { enabled: true }
    },
    runnerControl: { enabled: true, credentials: [{ id: 'runner-a' }] },
    plugins: { enabled: ['devmate.godot'], settings: { 'devmate.godot': { executablePath: '/opt/godot' } } },
    jobs: { embeddedRunnerEnabled: false },
    task: { currentTaskId: 'task-1' },
    trustedWritableRoots: [{ id: 'trusted-a', root: '/srv/a' }],
    workspaces: [{ id: 'app' }, { id: 'trusted-a', trusted: true, role: 'trusted' }]
  };
  const candidate = {
    instanceId: 'stale-instance',
    appVersion: '2.9.1',
    auth: { required: false, token: 'stale-owner-token' },
    runtime: { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000 },
    team: { enabled: false, requireWorkspaceLeaseForWrites: false, members: [] },
    vscodeContext: { capturedAt: 'now' },
    activeWorkspaceId: 'new-app',
    workspaces: [{ id: 'new-app' }]
  };
  const merged = mergeExtensionConfig(current, candidate);
  assert.equal(merged.instanceId, 'stable-instance');
  assert.equal(merged.appVersion, '2.9.1');
  assert.equal(merged.auth.required, false);
  assert.equal(merged.auth.token, 'current-owner-token');
  assert.equal(merged.runtime.maxConcurrentJobs, 4);
  assert.equal(merged.runtime.defaultCommandTimeoutMs, 2000);
  assert.deepEqual(merged.team.members, [{ id: 'alice' }]);
  assert.deepEqual(merged.team.approvals, { enabled: true });
  assert.deepEqual(merged.runnerControl.credentials, [{ id: 'runner-a' }]);
  assert.deepEqual(merged.plugins, current.plugins);
  assert.deepEqual(merged.jobs, current.jobs);
  assert.deepEqual(merged.task, current.task);
  assert.deepEqual(merged.trustedWritableRoots, current.trustedWritableRoots);
  assert.deepEqual(merged.workspaces.map(item => item.id), ['new-app', 'trusted-a']);
});

test('intercepts only the DevMate config path and writes it atomically', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-extension-config-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const otherPath = path.join(directory, 'other.json');
  await fsp.writeFile(configPath, JSON.stringify({
    instanceId: 'stable',
    team: { members: [{ id: 'member' }] },
    plugins: { enabled: ['devmate.godot'] }
  }));
  const restore = installConfigWriteInterceptor(fs, configPath);
  t.after(restore);
  fs.writeFileSync(configPath, `${JSON.stringify({
    instanceId: 'stale',
    appVersion: '2.9.1',
    team: { members: [] },
    vscodeContext: { capturedAt: 'now' }
  })}\n`, 'utf8');
  fs.writeFileSync(otherPath, '{"ordinary":true}\n', 'utf8');
  const saved = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  assert.equal(saved.instanceId, 'stable');
  assert.deepEqual(saved.team.members, [{ id: 'member' }]);
  assert.deepEqual(saved.plugins.enabled, ['devmate.godot']);
  assert.equal(saved.vscodeContext.capturedAt, 'now');
  assert.deepEqual(JSON.parse(await fsp.readFile(otherPath, 'utf8')), { ordinary: true });
  assert.deepEqual((await fsp.readdir(directory)).sort(), ['config.json', 'other.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('recovers an interrupted extension replacement backup', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-extension-recovery-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const replacement = `${configPath}.replace-1-2`;
  await fsp.writeFile(replacement, '{"recovered":true}\n');
  assert.equal(recoverReplacement(fs, configPath), replacement);
  assert.deepEqual(JSON.parse(await fsp.readFile(configPath, 'utf8')), { recovered: true });
  assert.equal(fs.existsSync(replacement), false);
});
