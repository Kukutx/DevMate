import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertGitRawWorkspaceBound } from '../gateway/git-raw-policy.mjs';
import {
  assertStructuredGitProtectedPaths,
  isProtectedGitPath
} from '../gateway/git-protected-path-guard.mjs';

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  return String(result.stdout || '').trim();
}

test('protected Git path policy recognizes secrets without blocking normal Godot/project assets', () => {
  for (const value of [
    '.env',
    '.env.production',
    'credentials.json',
    'config/service-account-key.json',
    'credentials/token.txt',
    '.godot/editor/project_metadata.cfg',
    'keys/id_ed25519',
    'private/client.pem'
  ]) assert.equal(isProtectedGitPath(value), true, value);

  for (const value of [
    '.env.example',
    '.env.sample',
    'Player.gd',
    'scenes/main.tscn',
    'assets/player.png',
    'addons/example/plugin.cfg'
  ]) assert.equal(isProtectedGitPath(value), false, value);
});

test('structured Git tools fail closed around tracked protected paths while explicit safe paths remain usable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-protected-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '--initial-branch=master']);
  git(root, ['config', 'user.name', 'DevMate Test']);
  git(root, ['config', 'user.email', 'devmate@example.invalid']);

  fs.mkdirSync(path.join(root, 'src', 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(root, 'safe.txt'), 'safe\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=initial-secret\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'credentials', 'token.txt'), 'nested-secret\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'initial']);

  fs.writeFileSync(path.join(root, 'safe.txt'), 'safe\nchanged\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=changed-secret\n', 'utf8');
  const workspace = { id: 'app', name: 'Application', root };

  await assert.rejects(
    () => assertStructuredGitProtectedPaths('git_diff', {}, workspace),
    error => error?.code === 'protected_git_path' && error.protectedPathCount === 1
  );
  await assert.doesNotReject(
    () => assertStructuredGitProtectedPaths('git_diff', { paths: ['safe.txt'] }, workspace)
  );
  await assert.rejects(
    () => assertStructuredGitProtectedPaths('git_blame', { path: '.env' }, workspace),
    error => error?.code === 'protected_git_path'
  );
  await assert.rejects(
    () => assertStructuredGitProtectedPaths('git_add', {}, workspace),
    error => error?.code === 'protected_git_path'
  );
  await assert.doesNotReject(
    () => assertStructuredGitProtectedPaths('git_add', { paths: ['safe.txt'] }, workspace)
  );
  await assert.rejects(
    () => assertStructuredGitProtectedPaths('git_add', { paths: ['src'] }, workspace),
    error => error?.code === 'protected_git_path'
  );

  git(root, ['add', '.env']);
  await assert.rejects(
    () => assertStructuredGitProtectedPaths('git_commit', { all: false }, workspace),
    error => error?.code === 'protected_git_path'
  );
  await assert.rejects(
    () => assertStructuredGitProtectedPaths('git_save', { paths: ['safe.txt'], all: false }, workspace),
    error => error?.code === 'protected_git_path'
  );
});

test('git_raw cannot bypass protected-content or structured staging/commit boundaries', () => {
  for (const command of [
    'add',
    'archive',
    'blame',
    'bundle',
    'cat-file',
    'checkout-index',
    'commit',
    'diff',
    'diff-files',
    'diff-index',
    'diff-tree',
    'format-patch',
    'grep',
    'log',
    'merge-file',
    'merge-tree',
    'mv',
    'range-diff',
    'show'
  ]) {
    assert.throws(
      () => assertGitRawWorkspaceBound([command, 'HEAD']),
      /expose protected content|safety controls/
    );
  }

  for (const args of [
    ['status', '--short'],
    ['rev-parse', '--show-toplevel'],
    ['show-ref', '--heads'],
    ['branch', '--show-current'],
    ['ls-files']
  ]) {
    assert.deepEqual(assertGitRawWorkspaceBound(args), args);
  }
});
