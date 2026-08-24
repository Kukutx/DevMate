import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const execFileAsync = promisify(execFile);
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-git-access-guard-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
const config = configStore.newInstanceConfig({ workspaceRoot: workspace, appVersion: configStore.DEFAULT_VERSION });
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces = [{ id: 'app', name: 'Application', root: workspace, reference: false, mode: 'workspace-write', role: 'active' }];
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const guard = await import('../gateway/git-access-guard.mjs');

async function git(args) {
  return execFileAsync('git', args, { cwd: workspace, encoding: 'utf8' });
}

async function write(rel, content) {
  const full = path.join(workspace, ...rel.split('/'));
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, 'utf8');
}

async function initGit() {
  await git(['init', '-q']);
  await git(['config', 'user.email', 'devmate-tests@example.invalid']);
  await git(['config', 'user.name', 'DevMate Tests']);
  await write('src/app.js', 'export const marker = "baseline";\n');
  await write('.env', 'SECRET=baseline\n');
  await git(['add', '--', 'src/app.js', '.env']);
  await git(['commit', '-q', '-m', 'baseline']);
}

test.beforeEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
  await fsp.mkdir(workspace, { recursive: true });
});

test('git_raw permits metadata-only commands but rejects content and mutation escape hatches', () => {
  for (const command of ['show', 'cat-file', 'config', 'grep', 'diff', 'log', 'add', 'commit', 'checkout']) {
    assert.throws(() => guard.__test.guardRaw({ args: [command] }), error => error?.code === 'git_raw_command_restricted');
  }
  for (const command of ['status', 'branch', 'rev-parse', 'describe', 'tag', 'ls-files']) {
    assert.equal(guard.__test.guardRaw({ args: [command] }).command, command);
  }
  assert.throws(() => guard.__test.guardRaw({ args: ['branch', 'new-branch'] }), error => error?.code === 'git_raw_mutation_restricted');
  assert.throws(() => guard.__test.guardRaw({ args: ['tag', 'v-secret'] }), error => error?.code === 'git_raw_mutation_restricted');
  assert.throws(() => guard.__test.guardRaw({ args: ['status', '--', '.env'] }), error => error?.code === 'sensitive_workspace_path');
  assert.throws(() => guard.__test.guardRaw({ args: ['--no-pager', 'status'] }), error => error?.code === 'git_raw_command_restricted');
});

test('commit boundary refuses protected files staged outside DevMate', async () => {
  await initGit();
  await write('.env', 'SECRET=externally-staged-secret\n');
  await git(['add', '--', '.env']);
  await assert.rejects(
    guard.__test.preflightCommitBoundary('git_commit', { workspaceId: 'app' }),
    error => error?.code === 'git_sensitive_path_commit_blocked' && error.blockedCount === 1
  );
  await assert.rejects(
    guard.__test.preflightCommitBoundary('git_save', { workspaceId: 'app', paths: ['src/app.js'] }),
    error => error?.code === 'git_sensitive_path_commit_blocked'
  );
});

test('project snapshot Git metadata drops protected status and suppresses diff stat when needed', () => {
  const result = {
    structuredContent: {
      git: {
        status: { stdout: '## main\n M src/app.js\n M .env\n?? .aws/credentials' },
        diffStat: { stdout: ' .env | 2 +-\n src/app.js | 1 +\n 2 files changed' }
      }
    },
    content: [{ type: 'text', text: '{}' }]
  };
  guard.__test.filterProjectSnapshot(result);
  assert.match(result.structuredContent.git.status.stdout, /src\/app\.js/);
  assert.doesNotMatch(result.structuredContent.git.status.stdout, /\.env|\.aws/);
  assert.equal(result.structuredContent.git.diffStat.stdout, '');
  assert.equal(result.structuredContent.git.diffStat.sensitivePathsOmitted, 2);
});

test('bounded safe Git review fails closed before constructing an oversized path argv', async () => {
  await initGit();
  for (let index = 0; index < guard.__test.MAX_SAFE_DIFF_PATHS + 1; index += 1) {
    await write(`generated/file-${String(index).padStart(3, '0')}.txt`, `change ${index}\n`);
  }
  await git(['add', '--', 'generated']);
  await assert.rejects(
    guard.__test.preflightDiffScale('git_staged_files', { workspaceId: 'app' }),
    error => error?.code === 'git_safe_diff_path_limit' && error.safePathCount > guard.__test.MAX_SAFE_DIFF_PATHS
  );
});

test('platform installs the Git guard between file safety and authorization', () => {
  const source = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'gateway', 'platform-capabilities.mjs'), 'utf8');
  const fileIndex = source.indexOf('installFileAccessHardening(McpServerClass)');
  const gitIndex = source.indexOf('installGitAccessGuard(McpServerClass)');
  const teamIndex = source.indexOf('installTeamCapabilities(McpServerClass)');
  assert.ok(fileIndex >= 0 && gitIndex > fileIndex && teamIndex > gitIndex);
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(root, { recursive: true, force: true });
});
