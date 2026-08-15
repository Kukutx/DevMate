import assert from 'node:assert/strict';
import test from 'node:test';
import { assertGitRawWorkspaceBound } from '../gateway/git-raw-policy.mjs';

test('git_raw rejects path-bearing options that escape the workspace', () => {
  for (const args of [
    ['archive', '--output=../outside.zip', 'HEAD'],
    ['archive', '--output=C:\\outside.zip', 'HEAD'],
    ['format-patch', '-o../outside', 'HEAD~1..HEAD'],
    ['checkout-index', '--all', '--prefix=../outside/'],
    ['apply', '--directory=nested/../../outside', 'patch.diff'],
    ['bundle', 'create', 'nested/../../outside.bundle', 'HEAD']
  ]) {
    assert.throws(() => assertGitRawWorkspaceBound(args), /git_raw path must stay inside the workspace/);
  }
});

test('git_raw rejects Git unsafe-path override', () => {
  assert.throws(
    () => assertGitRawWorkspaceBound(['apply', '--unsafe-paths', 'patch.diff']),
    /git_raw option is not allowed/
  );
});

test('git_raw blocks credential helpers, servers, and low-level remote writers', () => {
  for (const command of [
    'credential',
    'credential-cache',
    'credential-store',
    'daemon',
    'http-push',
    'send-pack',
    'shell'
  ]) {
    assert.throws(
      () => assertGitRawWorkspaceBound([command, 'origin']),
      /git_raw command is not allowed/
    );
  }
});

test('git_raw rejects unknown subcommands so Git shell aliases cannot become an execution bypass', () => {
  for (const command of ['deploy', 'pwn', 'my-company-alias']) {
    assert.throws(
      () => assertGitRawWorkspaceBound([command]),
      /reviewed builtin allowlist/
    );
  }
  assert.throws(() => assertGitRawWorkspaceBound(['--no-pager']), /explicit Git subcommand/);
});

test('git_raw still permits reviewed builtin commands and workspace-contained output paths', () => {
  for (const args of [
    ['status', '--short'],
    ['rev-parse', '--show-toplevel'],
    ['archive', '--output=artifacts/repo.zip', 'HEAD'],
    ['format-patch', '-oartifacts/patches', 'HEAD~1..HEAD'],
    ['checkout-index', '--all', '--prefix=artifacts/export/'],
    ['apply', 'patch.diff']
  ]) {
    assert.deepEqual(assertGitRawWorkspaceBound(args), args);
  }
});