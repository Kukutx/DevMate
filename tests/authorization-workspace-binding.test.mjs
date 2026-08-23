import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../gateway/team-capabilities.mjs';

const { bindAuthorizedWorkspaceArgs } = __test;

test('authorized workspace is pinned into execution args when the caller omitted it', () => {
  const original = { path: 'README.md' };
  const result = bindAuthorizedWorkspaceArgs(original, { workspaceId: 'workspace-a' });
  assert.deepEqual(result, { path: 'README.md', workspaceId: 'workspace-a' });
  assert.deepEqual(original, { path: 'README.md' }, 'authorization must not mutate the parsed caller arguments');
});

test('an explicit authorized workspace is preserved and global tools are unchanged', () => {
  const explicit = { workspaceId: 'workspace-a', path: 'README.md' };
  assert.equal(bindAuthorizedWorkspaceArgs(explicit, { workspaceId: 'workspace-a' }), explicit);
  const global = { query: 'status' };
  assert.equal(bindAuthorizedWorkspaceArgs(global, { workspaceId: null }), global);
});

test('authorized wrapper passes the pinned workspace to approval and execution', () => {
  const source = fs.readFileSync(path.resolve('gateway/team-capabilities.mjs'), 'utf8');
  assert.match(source, /const executionArgs = bindAuthorizedWorkspaceArgs\(authorizationArgs, authorized\)/);
  assert.match(source, /args: executionArgs/);
  assert.match(source, /handler\(executionArgs, \.\.\.rest\)/);
  assert.doesNotMatch(source, /handler\(args, \.\.\.rest\)/);
});
