import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCompanionContext, registerCompanionTools } from '../gateway/companion-capabilities.mjs';
import { validateToolRegistration, workspaceScopedTool } from '../gateway/tool-policy.mjs';
import { toolFamily } from '../gateway/plugins/tool-discovery.mjs';

test('companion context joins client-native browser work with DevMate local context without copying page data', () => {
  const config = {
    activeWorkspaceId: 'app',
    activeHostId: 'vscode-1',
    hostRuntime: { focusedHostId: 'obsidian-1' },
    workspaces: [
      { id: 'app', name: 'App', root: '/work/App', role: 'active', mode: 'workspace-write' },
      { id: 'docs', name: 'Docs', root: '/work/Docs', reference: true, mode: 'readonly' }
    ],
    hostContexts: {
      'vscode-1': {
        hostId: 'vscode-1',
        kind: 'editor',
        focused: false,
        workspaceRoot: '/work/App',
        activeEditor: { path: '/work/App/src/main.js' },
        updatedAt: '2026-09-11T02:00:00.000Z'
      },
      'obsidian-1': {
        hostId: 'obsidian-1',
        kind: 'obsidian',
        focused: true,
        workspaceRoot: '/work/Docs',
        activeDocument: { path: '/work/Docs/Notes/today.md' },
        updatedAt: '2026-09-11T02:01:00.000Z'
      }
    }
  };

  const context = buildCompanionContext(config);
  assert.equal(context.surface, 'chatgpt-browser-companion');
  assert.equal(context.integration.devmateModelApiKeyRequired, false);
  assert.equal(context.integration.browserContextSource, 'client-native');
  assert.equal(context.integration.pageContentMirroredByDevMate, false);
  assert.equal(context.currentProject.id, 'app');
  assert.equal(context.currentProject.rootLabel, 'App');
  assert.equal(context.focusedHost.hostId, 'obsidian-1');
  assert.equal(context.focusedHost.activeDocument, 'Notes/today.md');
  assert.equal(context.routing.browserFocusChangesCurrentProject, false);
  assert.equal(context.safety.browserPageContentIsUntrusted, true);
  assert.equal(context.workspaces.find(workspace => workspace.id === 'docs').writable, false);
});

test('companion context remains useful for general browsing when no project or desktop host exists', () => {
  const context = buildCompanionContext({ workspaces: [], hostContexts: {} }, { includeHosts: false });
  assert.equal(context.currentProject, null);
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
});
