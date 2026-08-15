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

test('git_raw still permits workspace-contained output paths', () => {
  for (const args of [
    ['archive', '--output=artifacts/repo.zip', 'HEAD'],
    ['format-patch', '-oartifacts/patches', 'HEAD~1..HEAD'],
    ['checkout-index', '--all', '--prefix=artifacts/export/']
  ]) {
    assert.deepEqual(assertGitRawWorkspaceBound(args), args);
  }
});
