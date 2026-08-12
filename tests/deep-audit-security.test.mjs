import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import lockRuntime from '../config-file-lock.cjs';
import {
  authorizeToolCall,
  createTeamMember,
  normalizeInstanceConfig,
  revokeTeamMember,
  rotateTeamMemberToken,
  updateTeamMember,
  verifyAccessToken
} from '../gateway/team-access.mjs';
import { requiredCapabilityForTool } from '../gateway/tool-policy.mjs';

function config() {
  return {
    auth: { required: true, token: 'owner-secret-token-value' },
    permissions: { profile: 'fullAccess' },
    connection: { provider: 'ngrok', publicUrl: '' },
    team: { members: [], requireWorkspaceLeaseForWrites: false },
    requestPolicy: {},
    runtime: {},
    jobs: {},
    activeWorkspaceId: 'app',
    workspaces: [
      { id: 'app', name: 'Application', reference: false, mode: 'workspace-write' },
      { id: 'other', name: 'Other', reference: false, mode: 'workspace-write' }
    ]
  };
}

function authorization(current, principal, name, args, annotations) {
  return authorizeToolCall({ name, args, annotations, config: current, principal });
}

test('durable-style team principals follow current role, scope, revocation, and token generation', () => {
  const current = normalizeInstanceConfig(config());
  const created = createTeamMember(current, { id: 'alice', name: 'Alice', role: 'developer', workspaceIds: ['app'] });
  const stale = verifyAccessToken(created.token, current);

  updateTeamMember(current, 'alice', { role: 'reviewer' });
  assert.throws(
    () => authorization(current, stale, 'write_file', { workspaceId: 'app' }, { destructiveHint: true }),
    /cannot use/
  );

  updateTeamMember(current, 'alice', { role: 'developer', workspaceIds: ['other'] });
  assert.throws(
    () => authorization(current, stale, 'read_file', { workspaceId: 'app' }, { readOnlyHint: true }),
    /not allowed to access workspace app/
  );

  const rotated = rotateTeamMemberToken(current, 'alice');
  assert.throws(
    () => authorization(current, stale, 'read_file', { workspaceId: 'other' }, { readOnlyHint: true }),
    error => error?.code === 'principal_inactive' && /rotated/.test(error.message)
  );

  const fresh = verifyAccessToken(rotated.token, current);
  assert.equal(
    authorization(current, fresh, 'read_file', { workspaceId: 'other' }, { readOnlyHint: true }).workspaceId,
    'other'
  );
  revokeTeamMember(current, 'alice');
  assert.throws(
    () => authorization(current, fresh, 'read_file', { workspaceId: 'other' }, { readOnlyHint: true }),
    error => error?.code === 'principal_inactive'
  );
});

test('git_raw classifies the actual subcommand after safe global options', () => {
  assert.equal(
    requiredCapabilityForTool('git_raw', { destructiveHint: true }, { args: ['--no-pager', 'push', 'origin', 'main'] }),
    'publish'
  );
  assert.equal(
    requiredCapabilityForTool('git_raw', { destructiveHint: true }, { args: ['--no-pager', 'status'] }),
    'git'
  );
});

test('team force-push aliases and force refspecs are blocked', () => {
  const current = normalizeInstanceConfig(config());
  const created = createTeamMember(current, { id: 'maintainer', name: 'Maintainer', role: 'maintainer', workspaceIds: ['app'] });
  const principal = verifyAccessToken(created.token, current);
  for (const args of [
    ['--no-pager', 'push', '-f', 'origin', 'main'],
    ['push', '--force-with-lease=main', 'origin', 'main'],
    ['push', 'origin', '+main:main']
  ]) {
    assert.throws(
      () => authorization(current, principal, 'git_raw', { workspaceId: 'app', args }, { destructiveHint: true }),
      /High-risk raw Git operations/
    );
  }
  assert.throws(
    () => authorization(current, principal, 'run_command', { workspaceId: 'app', command: 'git push -f origin main' }, { destructiveHint: true }),
    /high-risk command/
  );
});

test('file locks are never stolen solely because a live owner is old', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-live-lock-'));
  const file = path.join(root, 'config.json');
  const lockPath = `${file}.lock`;
  try {
    fs.writeFileSync(file, '{}');
    fs.writeFileSync(lockPath, JSON.stringify({
      token: 'other-owner',
      pid: process.pid,
      acquiredAt: new Date(Date.now() - 120000).toISOString(),
      file
    }));
    assert.equal(lockRuntime.staleLock(lockRuntime.readLock(lockPath), 1000), false);
    assert.throws(
      () => lockRuntime.acquireFileLock(file, { timeoutMs: 100, staleMs: 1000 }),
      error => error?.code === 'file_lock_timeout'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queue persistence carries token generation and inactive principals are non-retryable', () => {
  const queue = fs.readFileSync(new URL('../gateway/job-queue.mjs', import.meta.url), 'utf8');
  const runtime = fs.readFileSync(new URL('../gateway/job-runtime.mjs', import.meta.url), 'utf8');
  assert.equal(queue.includes('tokenVersion: Number.isInteger(principal?.tokenVersion)'), true);
  assert.equal(runtime.includes("'principal_inactive'"), true);
});
