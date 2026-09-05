import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bindConversationWorkspaceToPath,
  bindConversationWorkspaceToWorkspace,
  conversationWorkspaceBinding
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

test('unbound ChatGPT project tools fail closed instead of adopting the editor workspace', () => {
  const config = workspaceConfig();
  const decision = routingTest.routeDecision(config, scope, 'run_command', {});
  assert.equal(decision.kind, 'error');
  assert.equal(decision.error.code, 'conversation_workspace_binding_required');
  assert.match(decision.error.message, /will not use the active VS Code or Obsidian workspace automatically/);
});

test('legacy default bindings are ignored until the caller selects a project explicitly', () => {
  const config = workspaceConfig();
  bindConversationWorkspaceToWorkspace(config, scope, config.workspaces[0], { source: 'default' });

  const blocked = routingTest.routeDecision(config, scope, 'workspace_map', {});
  assert.equal(blocked.kind, 'error');
  assert.equal(blocked.error.code, 'conversation_workspace_binding_required');
  assert.match(blocked.error.message, /legacy implicit binding/);

  const explicit = routingTest.routeDecision(config, scope, 'workspace_map', { workspaceId: 'app' });
  assert.equal(explicit.kind, 'bind');
  assert.equal(explicit.selector, 'app');
});

test('an explicit conversation binding remains sticky and rejects silent project switches', () => {
  const config = workspaceConfig();
  bindConversationWorkspaceToWorkspace(config, scope, config.workspaces[1], { source: 'explicit-workspace' });

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

test('project-level non-workspace tools are guarded while routing control tools remain available', () => {
  assert.equal(routingTest.requiresExplicitConversationRoute('job_submit'), true);
  assert.equal(routingTest.requiresExplicitConversationRoute('work_session_start'), true);
  assert.equal(routingTest.requiresExplicitConversationRoute('published_preview_list'), true);
  assert.equal(routingTest.requiresExplicitConversationRoute('workspace_binding_status'), false);
  assert.equal(routingTest.requiresExplicitConversationRoute('workspace_bind'), false);
  assert.equal(routingTest.requiresExplicitConversationRoute('list_workspaces'), false);
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
