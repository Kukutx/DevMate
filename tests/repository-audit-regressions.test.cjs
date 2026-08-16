const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('path containment accepts dot-dot-prefixed names but still blocks parent paths', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-audit-path-'));
  try {
    const project = path.join(dir, 'project');
    await fsp.mkdir(project);
    await fsp.writeFile(path.join(project, '..notes.txt'), 'safe', 'utf8');
    const localShared = await import('../gateway/local-shared.mjs');
    const workspace = { root: project };
    assert.equal(localShared.resolveWorkspacePath(workspace, '..notes.txt'), path.join(project, '..notes.txt'));
    assert.throws(() => localShared.resolveWorkspacePath(workspace, '../outside.txt'), /escapes workspace root/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('signal termination semantics preserve ownership until the owning lifecycle confirms exit', () => {
  const commandProcess = source('gateway/command-process.mjs');
  const processController = source('host/runtime/process-controller.js');
  assert.match(commandProcess, /exitConfirmed/);
  assert.match(processController, /exitConfirmed/);
  assert.doesNotMatch(commandProcess, /child\.killed\s*\?\s*true/);
});

test('gateway write locks preserve case-sensitive file identities', () => {
  const server = source('gateway/server.mjs');
  assert.match(server, /process\.platform === 'win32'/);
  assert.doesNotMatch(server, /toLowerCase\(\).*withLock/s);
});

test('audit pruning stays private and overlapping calls do not share temp files', async () => {
  const maintenance = source('gateway/maintenance.mjs');
  assert.match(maintenance, /randomBytes/);
  assert.match(maintenance, /audit\.prune-/);
  assert.doesNotMatch(maintenance, /\.prune\.tmp/);
});

test('instance lock lease uses current requestPolicy timeout', () => {
  const durable = source('gateway/durable-state.mjs');
  assert.match(durable, /config\?\.requestPolicy\?\.requestTimeoutMs/);
  assert.doesNotMatch(durable, /config\?\.production\?\.requestTimeoutMs/);
});

test('git_raw cannot relocate Git or target filesystem state outside the workspace', async () => {
  const { assertGitRawWorkspaceBound } = await import('../gateway/git-raw-policy.mjs');
  assert.deepEqual(assertGitRawWorkspaceBound(['status', '--short']), ['status', '--short']);
  assert.deepEqual(assertGitRawWorkspaceBound(['show-ref', '--heads']), ['show-ref', '--heads']);
  assert.throws(() => assertGitRawWorkspaceBound(['log', '-1']), /git_raw command is not allowed/);
  for (const args of [
    ['-C', os.tmpdir(), 'status'],
    [`--git-dir=${path.join(os.tmpdir(), 'repo.git')}`, 'status'],
    [`--work-tree=${os.tmpdir()}`, 'status'],
    ['-c', 'alias.escape=!echo nope', 'escape'],
    ['config', '--global', 'user.name', 'x'],
    ['init', os.tmpdir()],
    ['status', path.resolve(os.tmpdir(), 'outside')],
    ['status', '../outside']
  ]) {
    assert.throws(() => assertGitRawWorkspaceBound(args), /git_raw/);
  }
});

test('automatic backups fail closed before destructive file mutations', () => {
  const server = source('gateway/server.mjs');
  assert.match(server, /Backup failed before mutation/);
  assert.doesNotMatch(server, /return `backup_failed:/);
});
