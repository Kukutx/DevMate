import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { conversationScopeFromToolContext, runWithConversationScope } from '../gateway/request-context.mjs';
import { bindConversationWorkspaceToPath, conversationWorkspaceBinding, pruneConversationWorkspaceBindings } from '../gateway/conversation-workspaces.mjs';
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

test('project selection does not expire just because a conversation is old', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-stable-project-'));
  const config = { activeWorkspaceId: 'app', workspaces: [{ id: 'app', name: 'App', root, mode: 'workspace-write', reference: false }] };
  bindConversationWorkspaceToPath(config, scopeA, root, { allowExternalWrite: true, now: 0 });
  pruneConversationWorkspaceBindings(config, 365 * 24 * 60 * 60 * 1000);
  assert.equal(conversationWorkspaceBinding(config, scopeA)?.root, fs.realpathSync.native(root));
});

test('project resource fences do not restore conversation ownership locks', () => {
  const capabilitySource = fs.readFileSync(new URL('../gateway/team-capabilities.mjs', import.meta.url), 'utf8');
  const collaborationSource = fs.readFileSync(new URL('../gateway/team-collaboration-tools.mjs', import.meta.url), 'utf8');
  const jobSource = fs.readFileSync(new URL('../gateway/job-tools.mjs', import.meta.url), 'utf8');
  const combined = capabilitySource + collaborationSource + jobSource;
  assert.doesNotMatch(combined, /conversation_resource_conflict|work_session_conversation_conflict|conversation_workspace_durable_job_unsafe|belongs to another ChatGPT conversation|must deliberately bind/);
  assert.match(collaborationSource, /different project workspace/);
  assert.match(jobSource, /different project workspace/);
});
