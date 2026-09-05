import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertConversationWorkspaceMatch,
  bindConversationWorkspaceToPath,
  bindConversationWorkspaceToWorkspace,
  conversationWorkspace,
  conversationWorkspaceBinding,
  explicitConversationWorkspaceBinding,
  publicConversationWorkspaceBinding
} from '../gateway/conversation-workspaces.mjs';
import { installConversationRoutingGuard, __test as routingTest } from '../gateway/conversation-routing-guard.mjs';
import { serverExtensionHostStatus } from '../gateway/server-extension-host.mjs';

const scope = 'chatgpt-' + 'c'.repeat(32);

function workspaceConfig() {
  const crew = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-routing-crew-'));
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-routing-app-'));
  return {
    activeWorkspaceId: 'crew',
    workspaces: [
      { id: 'crew', name: 'Crew', root: crew, mode: 'workspace-write', reference: false },
      { id: 'app', name: 'App', root: app, mode: 'workspace-write', reference: false }
    ]
  };
}

test('unbound ChatGPT project tools keep the current VS Code workspace as the default', () => {
  const config = workspaceConfig();
  const decision = routingTest.routeDecision(config, scope, 'run_command', {});
  assert.equal(decision.kind, 'pass');
  assert.deepEqual(decision.args, {});
});

test('implicit default follows host workspace changes instead of pinning the conversation', () => {
  const config = workspaceConfig();
  bindConversationWorkspaceToWorkspace(config, scope, config.workspaces[0], { source: 'default' });

  assert.equal(conversationWorkspace(config, scope).id, 'crew');
  assert.equal(publicConversationWorkspaceBinding(config, scope).workspaceId, 'crew');
  assert.equal(publicConversationWorkspaceBinding(config, scope).implicit, true);
  assert.equal(explicitConversationWorkspaceBinding(config, scope), null);

  config.activeWorkspaceId = 'app';

  assert.equal(conversationWorkspace(config, scope).id, 'app');
  assert.equal(publicConversationWorkspaceBinding(config, scope).workspaceId, 'app');
  assert.equal(conversationWorkspaceBinding(config, scope).workspaceId, 'crew');
});

test('an explicit selector replaces an unbound or implicit default route', () => {
  const config = workspaceConfig();
  const unbound = routingTest.routeDecision(config, scope, 'workspace_map', { workspaceId: 'app' });
  assert.equal(unbound.kind, 'bind');
  assert.equal(unbound.selector, 'app');

  bindConversationWorkspaceToWorkspace(config, scope, config.workspaces[0], { source: 'default' });
  const implicit = routingTest.routeDecision(config, scope, 'workspace_map', { workspaceId: 'app' });
  assert.equal(implicit.kind, 'bind');
  assert.equal(implicit.selector, 'app');

  assert.doesNotThrow(() => assertConversationWorkspaceMatch(config, scope, config.workspaces[1]));
});

test('an explicit conversation binding remains sticky across host switches', () => {
  const config = workspaceConfig();
  bindConversationWorkspaceToWorkspace(config, scope, config.workspaces[1], { source: 'explicit-workspace' });

  config.activeWorkspaceId = 'crew';
  assert.equal(conversationWorkspace(config, scope).id, 'app');
  assert.equal(publicConversationWorkspaceBinding(config, scope).implicit, false);

  const same = routingTest.routeDecision(config, scope, 'run_command', { workspaceId: 'app', command: 'echo ok' });
  assert.equal(same.kind, 'pass');
  assert.equal(same.args.workspaceId, 'app');

  const inherited = routingTest.routeDecision(config, scope, 'run_command', { command: 'echo ok' });
  assert.equal(inherited.kind, 'pass');

  const conflict = routingTest.routeDecision(config, scope, 'run_command', { workspaceId: 'crew', command: 'echo no' });
  assert.equal(conflict.kind, 'error');
  assert.equal(conflict.error.code, 'conversation_workspace_conflict');
});

test('absolute workspaceId compatibility selectors preserve exact path bindings', () => {
  const config = workspaceConfig();
  const nested = path.join(config.workspaces[1].root, 'nested');
  fs.mkdirSync(nested);
  bindConversationWorkspaceToPath(config, scope, nested, { source: 'explicit-path', allowExternalWrite: true });
  const binding = conversationWorkspaceBinding(config, scope);

  const decision = routingTest.routeDecision(config, scope, 'workspace_map', { workspaceId: nested });
  assert.equal(decision.kind, 'pass');
  assert.equal(decision.args.workspaceId, binding.workspaceId);
  assert.equal(binding.root, fs.realpathSync.native(nested));
});

test('project-level non-workspace tools are routed while control tools stay available', () => {
  assert.equal(routingTest.requiresConversationRoute('job_submit'), true);
  assert.equal(routingTest.requiresConversationRoute('work_session_start'), true);
  assert.equal(routingTest.requiresConversationRoute('published_preview_list'), true);
  assert.equal(routingTest.requiresConversationRoute('workspace_binding_status'), false);
  assert.equal(routingTest.requiresConversationRoute('workspace_bind'), false);
  assert.equal(routingTest.requiresConversationRoute('list_workspaces'), false);
});

test('conversation routing decorator executes outside authorization at order 11', () => {
  class FakeMcpServer {
    registerTool() {}
    connect() {}
  }
  installConversationRoutingGuard(FakeMcpServer);
  const status = serverExtensionHostStatus(FakeMcpServer);
  assert.deepEqual(status.decorators, [{ id: 'devmate.conversation-routing', order: 11 }]);
});
