
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkspace, resolveWorkspaceId } from '../gateway/workspace-resolver.mjs';

test('exact workspace ID wins over a colliding display name', () => {
  const config = {
    activeWorkspaceId: 'write',
    workspaces: [
      { id: 'write', name: 'reference', reference: false },
      { id: 'reference', name: 'write', reference: true, mode: 'readonly' }
    ]
  };
  assert.equal(resolveWorkspace(config, 'reference').id, 'reference');
  assert.equal(resolveWorkspaceId(config, 'write'), 'write');
});

test('ambiguous names are rejected instead of using array order', () => {
  const config = {
    workspaces: [
      { id: 'a', name: 'same', reference: false },
      { id: 'b', name: 'same', reference: true }
    ]
  };
  assert.throws(() => resolveWorkspace(config, 'same'), error => {
    assert.equal(error.code, 'workspace_ambiguous');
    assert.deepEqual(error.matches.map(item => item.id), ['a', 'b']);
    return true;
  });
});
