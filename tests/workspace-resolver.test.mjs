
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkspace, resolveWorkspaceId } from '../gateway/workspace-resolver.mjs';
import { toolWorkspaceId } from '../gateway/tool-policy.mjs';

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

test('requires an explicit workspace ID when multiple workspaces are writable', () => {
  const config = {
    activeWorkspaceId: 'a',
    workspaces: [
      { id: 'a', name: 'first', reference: false, mode: 'workspace-write' },
      { id: 'b', name: 'second', reference: false, mode: 'workspace-write' },
      { id: 'docs', name: 'docs', reference: true, mode: 'readonly' }
    ]
  };
  assert.throws(() => resolveWorkspace(config), error => {
    assert.equal(error.code, 'workspace_selection_required');
    assert.deepEqual(error.workspaces.map(item => item.id), ['a', 'b']);
    return true;
  });
  assert.equal(resolveWorkspace(config, 'b').name, 'second');
});

test('trusted-root administration stays global after it creates a second writable root', () => {
  const config = {
    activeWorkspaceId: 'app',
    workspaces: [
      { id: 'app', name: 'app', mode: 'workspace-write' },
      { id: 'trusted', name: 'trusted', mode: 'workspace-write', trusted: true }
    ]
  };
  assert.equal(toolWorkspaceId('add_trusted_root', {}, config), null);
  assert.equal(toolWorkspaceId('remove_trusted_root', { id: 'trusted' }, config), null);
});
