
import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceIds } from '../gateway/team-tool-data.mjs';

test('team and Runner scopes prefer exact workspace IDs', () => {
  const config = {
    workspaces: [
      { id: 'active', name: 'reference', reference: false },
      { id: 'reference', name: 'active', reference: true, mode: 'readonly' }
    ]
  };
  assert.deepEqual(workspaceIds(config, ['reference']), ['reference']);
  assert.deepEqual(workspaceIds(config, ['active']), ['active']);
});

test('team and Runner scopes reject ambiguous display names', () => {
  const config = {
    workspaces: [
      { id: 'one', name: 'same' },
      { id: 'two', name: 'same', reference: true }
    ]
  };
  assert.throws(() => workspaceIds(config, ['same']), error => {
    assert.equal(error.code, 'workspace_ambiguous');
    return true;
  });
});
