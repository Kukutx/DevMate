import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationScopeFromToolContext, runWithConversationScope } from '../gateway/request-context.mjs';
import { bindConversationWorkspaceToPath } from '../gateway/conversation-workspaces.mjs';
import { resolveWorkspace } from '../gateway/workspace-resolver.mjs';
import { activeWorkSession, clearWorkSessions, startWorkSession } from '../gateway/work-sessions.mjs';
import { clearWorkspaceLeases } from '../gateway/workspace-leases.mjs';
import { __test as capabilityTest } from '../gateway/team-capabilities.mjs';

const scopeA = 'chatgpt-' + 'a'.repeat(32);
const scopeB = 'chatgpt-' + 'b'.repeat(32);

test('reconnect keeps the same conversation identity', () => {
  const a1 = conversationScopeFromToolContext({ mcpReq: { _meta: { 'openai/session': 'conversation-a' } } });
  const a2 = conversationScopeFromToolContext({ mcpReq: { _meta: { 'openai/session': 'conversation-a' } } });
  const b = conversationScopeFromToolContext({ mcpReq: { _meta: { 'openai/session': 'conversation-b' } } });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test('explicit local path wins for that conversation', () => {
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-explicit-'));
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-default-'));
  const config = { activeWorkspaceId: 'host', workspaces: [{ id: 'host', name: 'Host', root: host, mode: 'workspace-write', reference: false }] };
  bindConversationWorkspaceToPath(config, scopeA, explicit, { allowExternalWrite: true });
  runWithConversationScope(scopeA, () => assert.equal(resolveWorkspace(config, '').root, fs.realpathSync.native(explicit)));
  runWithConversationScope(scopeB, () => assert.equal(resolveWorkspace(config, '').id, 'host'));
});

test('without a path a new conversation uses the current default workspace', () => {
  const one = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-one-'));
  const two = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-two-'));
  const config = { activeWorkspaceId: 'two', workspaces: [
    { id: 'one', name: 'One', root: one, mode: 'workspace-write', reference: false },
    { id: 'two', name: 'Two', root: two, mode: 'workspace-write', reference: false }
  ] };
  assert.equal(capabilityTest.defaultConversationWorkspace(config).id, 'two');
});

test('same-project work records remain shareable across conversations', () => {
  clearWorkSessions();
  clearWorkspaceLeases();
  const principal = { id: 'local-owner', name: 'Local owner', role: 'owner', source: 'local' };
  let session;
  runWithConversationScope(scopeA, () => { session = startWorkSession({ principal, workspaceId: 'app' }); });
  runWithConversationScope(scopeB, () => assert.equal(activeWorkSession(principal.id, 'app')?.id, session.id));
  clearWorkSessions();
  clearWorkspaceLeases();
});
