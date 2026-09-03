import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationScopeFromToolContext, runWithConversationScope } from '../gateway/request-context.mjs';
import { bindConversationWorkspaceToPath, conversationWorkspace } from '../gateway/conversation-workspaces.mjs';
import { resolveWorkspace } from '../gateway/workspace-resolver.mjs';
import { activeWorkSession, clearWorkSessions, startWorkSession } from '../gateway/work-sessions.mjs';
import { clearWorkspaceLeases } from '../gateway/workspace-leases.mjs';

const scopeA = 'chatgpt-' + 'a'.repeat(32);
const scopeB = 'chatgpt-' + 'b'.repeat(32);
test('conversation metadata is stable across supported keys', () => {
  const a1 = conversationScopeFromToolContext({ mcpReq: { _meta: { 'openai/session': 'conversation-a' } } });
  const a2 = conversationScopeFromToolContext({ mcpReq: { _meta: { 'openai/conversationId': 'conversation-a' } } });
  const b = conversationScopeFromToolContext({ mcpReq: { _meta: { 'openai/session': 'conversation-b' } } });
  assert.equal(a1, a2); assert.notEqual(a1, b); assert.match(a1, /^chatgpt-[a-f0-9]{32}$/);
});
test('explicit local path overrides host active workspace only in its conversation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-conversation-root-'));
  const host = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-host-root-'));
  const config = { activeWorkspaceId: 'host', workspaces: [{ id: 'host', name: 'Host', root: host, mode: 'workspace-write', reference: false }] };
  bindConversationWorkspaceToPath(config, scopeA, root, { allowExternalWrite: true });
  runWithConversationScope(scopeA, () => { assert.equal(resolveWorkspace(config, '').root, fs.realpathSync.native(root)); assert.equal(conversationWorkspace(config).root, fs.realpathSync.native(root)); });
  runWithConversationScope(scopeB, () => assert.equal(resolveWorkspace(config, '').id, 'host'));
});
test('work sessions are never adopted by another conversation', () => {
  clearWorkSessions(); clearWorkspaceLeases();
  const principal = { id: 'local-owner', name: 'Local owner', role: 'owner', source: 'local' };
  const session = startWorkSession({ principal, workspaceId: 'app', conversationScope: scopeA });
  assert.equal(activeWorkSession(principal.id, 'app', scopeA)?.id, session.id);
  assert.equal(activeWorkSession(principal.id, 'app', scopeB), null);
  assert.throws(() => startWorkSession({ principal, workspaceId: 'app', conversationScope: scopeB }), e => e?.code === 'work_session_conversation_conflict');
  clearWorkSessions(); clearWorkspaceLeases();
});
test('authorization refuses silent host adoption and scopes secondary resources', () => {
  const source = fs.readFileSync(new URL('../gateway/team-capabilities.mjs', import.meta.url), 'utf8');
  assert.match(source, /conversation_workspace_binding_required/);
  assert.match(source, /DevMate will not silently use the current VS Code or Obsidian workspace/);
  assert.doesNotMatch(source, /source:\s*'auto'/);
  assert.match(source, /processConversationScope/);
  assert.match(source, /previewConversationScope/);
  const approvals = fs.readFileSync(new URL('../gateway/approvals.mjs', import.meta.url), 'utf8');
  assert.match(approvals, /conversationScope/);
});
