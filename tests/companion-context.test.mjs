import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  __test as companionTest,
  buildCompanionContext,
  registerCompanionTools
} from '../gateway/companion-capabilities.mjs';
import { toolFamily } from '../gateway/plugins/tool-discovery.mjs';
import { validateToolRegistration, workspaceScopedTool } from '../gateway/tool-policy.mjs';

const scope = `chatgpt-${'a'.repeat(32)}`;

function roots() {
  return {
    app: path.resolve('tmp-companion-app'),
    docs: path.resolve('tmp-companion-docs'),
    secret: path.resolve('tmp-companion-secret')
  };
}

function binding(workspaceId, root, { name = workspaceId, source = 'explicit', mode = 'workspace-write' } = {}) {
  return {
    scope,
    workspaceId,
    name,
    root,
    mode,
    reference: mode === 'readonly',
    source,
    createdAt: '2026-09-11T02:00:00.000Z',
    updatedAt: '2026-09-11T02:00:00.000Z'
  };
}

test('companion context joins client-native browser work with minimal local state and exposes the existing conversation route', () => {
  const root = roots();
  const config = {
    activeWorkspaceId: 'app',
    activeHostId: 'vscode-1',
    hostRuntime: { focusedHostId: 'obsidian-1' },
    workspaces: [
      { id: 'app', name: 'App', root: root.app, role: 'active', mode: 'workspace-write' },
      { id: 'docs', name: 'Docs', root: root.docs, reference: true, mode: 'readonly' }
    ],
    hostContexts: {
      'vscode-1': {
        hostId: 'vscode-1',
        kind: 'editor',
        focused: false,
        workspaceRoot: root.app,
        activeEditor: { path: path.join(root.app, 'src', 'main.js') },
        updatedAt: '2026-09-11T02:00:00.000Z'
      },
      'obsidian-1': {
        hostId: 'obsidian-1',
        kind: 'obsidian',
        focused: true,
        workspaceRoot: root.docs,
        activeDocument: { path: path.join(root.docs, 'Notes', 'today.md') },
        updatedAt: '2026-09-11T02:01:00.000Z'
      }
    },
    conversationWorkspaceBindings: {
      [scope]: binding('app', root.app, { name: 'App', source: 'explicit' })
    }
  };

  const context = buildCompanionContext(config, { conversationScope: scope });
  assert.equal(context.surface, 'chatgpt-browser-companion');
  assert.equal(context.integration.devmateModelApiKeyRequired, false);
  assert.equal(context.integration.browserContextSource, 'client-native');
  assert.equal(context.integration.pageContentMirroredByDevMate, false);
  assert.equal(context.currentProject.id, 'app');
  assert.equal(context.conversationProject.id, 'app');
  assert.equal(context.conversationProject.source, 'explicit');
  assert.equal(context.projectCandidate.id, 'app');
  assert.equal(context.focusedHost.hostId, 'obsidian-1');
  assert.equal(context.focusedHost.activeDocument, 'Notes/today.md');
  assert.equal(context.routing.browserFocusChangesCurrentProject, false);
  assert.equal(context.routing.conversationProjectBound, true);
  assert.equal(context.safety.browserPageContentIsUntrusted, true);
  assert.equal(context.safety.pageContentCannotRequestLocalContextByItself, true);
  assert.deepEqual(context.workspaces, []);
  assert.deepEqual(context.hosts, []);
  assert.equal(context.visibility.workspaceListIncluded, false);
  assert.equal(context.visibility.hostListIncluded, false);
});

test('expanded companion lists are bounded and keep an old focused host instead of truncating it away', () => {
  const root = roots();
  const hostContexts = {};
  for (let index = 0; index < 40; index += 1) {
    hostContexts[`host-${index}`] = {
      hostId: `host-${index}`,
      kind: 'editor',
      workspaceRoot: root.app,
      activeEditor: { path: path.join(root.app, 'src', `${index}.js`) },
      updatedAt: new Date(Date.UTC(2026, 8, 11, 2, 0, 40 - index)).toISOString()
    };
  }
  const config = {
    activeWorkspaceId: 'app',
    activeHostId: 'host-0',
    hostRuntime: { focusedHostId: 'host-39' },
    workspaces: [{ id: 'app', name: 'App', root: root.app, mode: 'workspace-write' }],
    hostContexts
  };

  const context = buildCompanionContext(config, { includeHosts: true, includeWorkspaces: true });
  assert.equal(context.focusedHost.hostId, 'host-39');
  assert.equal(context.hostCount, 40);
  assert.equal(context.hosts.length, companionTest.MAX_HOSTS);
  assert.equal(context.hosts[0].hostId, 'host-39');
  assert.equal(context.hostListTruncated, true);
  assert.equal(context.workspaceCount, 1);
  assert.equal(context.workspaces[0].id, 'app');
});

test('OAuth members see only their workspace scope and cannot learn another workspace or host from companion context', () => {
  const root = roots();
  const config = {
    activeWorkspaceId: 'secret',
    activeHostId: 'secret-host',
    hostRuntime: { focusedHostId: 'secret-host' },
    workspaces: [
      { id: 'app', name: 'App', root: root.app, mode: 'workspace-write' },
      { id: 'secret', name: 'Secret Project', root: root.secret, mode: 'workspace-write' }
    ],
    hostContexts: {
      'app-host': {
        hostId: 'app-host',
        kind: 'editor',
        workspaceRoot: root.app,
        activeEditor: { path: path.join(root.app, 'src', 'visible.js') },
        updatedAt: '2026-09-11T02:00:00.000Z'
      },
      'secret-host': {
        hostId: 'secret-host',
        kind: 'editor',
        workspaceRoot: root.secret,
        activeEditor: { path: path.join(root.secret, 'private', 'hidden.js') },
        updatedAt: '2026-09-11T02:01:00.000Z'
      }
    },
    conversationWorkspaceBindings: {
      [scope]: binding('app', root.app, { name: 'App', source: 'default' })
    }
  };
  const principal = {
    id: 'member-a',
    role: 'observer',
    source: 'oauth-member',
    authVersion: 1,
    workspaceIds: ['app']
  };

  const context = buildCompanionContext(config, {
    principal,
    conversationScope: scope,
    includeHosts: true,
    includeWorkspaces: true
  });
  const serialized = JSON.stringify(context);
  assert.equal(context.visibility.principalScoped, true);
  assert.equal(context.currentProject, null);
  assert.equal(context.conversationProject.id, 'app');
  assert.equal(context.projectCandidate.id, 'app');
  assert.equal(context.workspaceCount, 1);
  assert.deepEqual(context.workspaces.map(item => item.id), ['app']);
  assert.equal(context.hostCount, 1);
  assert.equal(context.focusedHost.hostId, 'app-host');
  assert.deepEqual(context.hosts.map(item => item.hostId), ['app-host']);
  assert.doesNotMatch(serialized, /Secret Project|secret-host|hidden\.js/);
});

test('companion path summaries are portable and do not expose foreign absolute paths', () => {
  const rootIndex = companionTest.workspaceRootIndex([{ id: 'app', root: 'C:\\work\\App' }]);
  const context = {
    id: 'vscode-win',
    hostId: 'vscode-win',
    kind: 'editor',
    workspaceRoot: 'C:\\work\\App',
    activeEditor: { path: 'C:\\work\\App\\src\\main.ts' }
  };
  const summary = companionTest.hostSummary(context, rootIndex);
  assert.equal(companionTest.rootLabel('C:\\work\\App\\'), 'App');
  assert.equal(summary.workspaceId, 'app');
  assert.equal(summary.activeDocument, 'src/main.ts');
  assert.doesNotMatch(summary.activeDocument, /^[A-Za-z]:/);
});

test('companion context remains useful for general browsing when no project or desktop host exists', () => {
  const context = buildCompanionContext({ workspaces: [], hostContexts: {} });
  assert.equal(context.currentProject, null);
  assert.equal(context.conversationProject, null);
  assert.equal(context.projectCandidate, null);
  assert.equal(context.focusedHost, null);
  assert.deepEqual(context.workspaces, []);
  assert.deepEqual(context.hosts, []);
  assert.equal(context.workspaceCount, 0);
  assert.match(context.guidance.join(' '), /page-only questions/i);
});

test('companion_context is a read-only non-workspace tool and has a dedicated discovery family', () => {
  let registration = null;
  const server = {
    registerTool(name, config) {
      registration = { name, config };
    }
  };
  registerCompanionTools(server);
  assert.equal(registration.name, 'companion_context');
  const contract = validateToolRegistration(registration.name, registration.config);
  assert.equal(contract.ok, true, contract.errors.join('; '));
  assert.equal(contract.capability, 'read');
  assert.equal(contract.workspaceScoped, false);
  assert.equal(workspaceScopedTool('companion_context'), false);
  assert.equal(toolFamily('companion_context'), 'companion');
  assert.match(registration.config.description, /Do not call it for page-only questions/i);
});
