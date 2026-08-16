const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

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
