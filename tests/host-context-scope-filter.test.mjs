import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../gateway/team-capabilities.mjs';

function makeResult(structuredContent, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...extra
  };
}

function fixture() {
  const appRoot = path.resolve('tmp-scope-app');
  const secretRoot = path.resolve('tmp-scope-secret');
  const current = {
    workspaces: [
      { id: 'app', root: appRoot, name: 'App' },
      { id: 'secret', root: secretRoot, name: 'Secret' }
    ],
    hostContexts: {
      app: { hostId: 'app-host', workspaceRoot: appRoot, activeEditor: { path: 'src/app.js' } },
      secret: { hostId: 'secret-host', workspaceRoot: secretRoot, activeEditor: { path: 'private/hidden.js' } }
    }
  };
  const principal = { id: 'member', source: 'oauth-member', role: 'observer', workspaceIds: ['app'] };
  return { appRoot, secretRoot, current, principal };
}

test('OAuth members cannot read host-context metadata outside the authorized conversation workspace', () => {
  const { appRoot, secretRoot, current, principal } = fixture();
  const listed = makeResult({
    activeHostId: 'secret-host',
    focusedHostId: 'secret-host',
    hosts: [
      { id: 'app', hostId: 'app-host', workspaceRoot: appRoot, activeDocument: 'src/app.js' },
      { id: 'secret', hostId: 'secret-host', workspaceRoot: secretRoot, activeDocument: 'private/hidden.js' }
    ]
  });
  __test.filterResult('host_context_list', listed, principal, 'app', current);
  assert.deepEqual(listed.structuredContent.hosts.map(item => item.hostId), ['app-host']);
  assert.equal(listed.structuredContent.activeHostId, null);
  assert.equal(listed.structuredContent.focusedHostId, null);
  assert.doesNotMatch(JSON.stringify(listed), /secret-host|hidden\.js/);

  const requested = makeResult({
    activeHostId: 'secret-host',
    focusedHostId: 'secret-host',
    requestedHostId: 'secret-host',
    context: { id: 'secret', hostId: 'secret-host', workspaceRoot: secretRoot, activeEditor: { path: 'private/hidden.js' } }
  });
  __test.filterResult('host_context', requested, principal, 'app', current);
  assert.equal(requested.structuredContent.context, null);
  assert.equal(requested.structuredContent.activeHostId, null);
  assert.equal(requested.structuredContent.focusedHostId, null);
  assert.doesNotMatch(JSON.stringify(requested.structuredContent.context), /hidden\.js/);
});

test('OAuth members get fail-closed VS Code editor and diagnostic results when the focused host is outside scope', () => {
  const { secretRoot, current, principal } = fixture();

  const vscode = makeResult({
    hostId: 'secret-host',
    workspaceRoot: secretRoot,
    capturedAt: '2026-09-11T12:00:00.000Z',
    activeEditor: { path: 'private/hidden.js' },
    visibleEditors: [{ path: 'private/hidden.js' }],
    diagnostics: [{ path: 'private/hidden.js', message: 'secret diagnostic' }]
  });
  __test.filterResult('vscode_context', vscode, principal, 'app', current);
  assert.equal(vscode.structuredContent.activeEditor, null);
  assert.deepEqual(vscode.structuredContent.visibleEditors, []);
  assert.deepEqual(vscode.structuredContent.diagnostics, []);
  assert.doesNotMatch(JSON.stringify(vscode), /hidden\.js|secret diagnostic/);

  const editor = makeResult({ capturedAt: '2026-09-11T12:00:00.000Z', workspaceId: 'secret', activeEditor: { path: 'private/hidden.js' } });
  __test.filterResult('active_editor_context', editor, principal, 'app', current);
  assert.deepEqual(editor.structuredContent, { capturedAt: null, workspaceId: null, activeEditor: null });

  const diagnostics = makeResult({ capturedAt: '2026-09-11T12:00:00.000Z', workspaceId: 'secret', diagnostics: [{ path: 'private/hidden.js' }], total: 1 });
  __test.filterResult('list_diagnostics', diagnostics, principal, 'app', current);
  assert.deepEqual(diagnostics.structuredContent, { capturedAt: null, workspaceId: null, diagnostics: [], total: 0 });
});

test('global connection diagnostics hide VS Code details outside an OAuth member workspace scope', () => {
  const { current, principal } = fixture();
  const data = {
    status: 'ready',
    vscode: {
      contextPresent: true,
      workspaceId: 'secret',
      capturedAt: '2026-09-11T12:00:00.000Z',
      contextAgeSeconds: 1,
      fresh: true,
      activeEditor: { path: 'private/hidden.js' },
      visibleEditorCount: 1,
      diagnostics: { total: 1, bySeverity: { error: 1, warning: 0, information: 0, hint: 0 } }
    },
    workspace: { active: { id: 'secret' }, count: 2, references: 0 }
  };
  const result = makeResult(data, { _meta: { diagnostics: data } });
  __test.filterResult('devmate_status_panel', result, principal, null, current);
  assert.equal(result.structuredContent.vscode.contextPresent, false);
  assert.equal(result.structuredContent.vscode.activeEditor, null);
  assert.equal(result.structuredContent.vscode.workspaceId, null);
  assert.equal(result.structuredContent.workspace.active, null);
  assert.equal(result._meta.diagnostics, result.structuredContent);
  assert.doesNotMatch(JSON.stringify(result), /hidden\.js/);
});

test('local owner host-context behavior is unchanged by member result filtering', () => {
  const { secretRoot, current } = fixture();
  const owner = { id: 'local-owner', source: 'local-owner', role: 'owner', workspaceIds: [] };
  const result = makeResult({ workspaceRoot: secretRoot, activeEditor: { path: 'private/hidden.js' }, visibleEditors: [], diagnostics: [] });
  __test.filterResult('vscode_context', result, owner, null, current);
  assert.equal(result.structuredContent.activeEditor.path, 'private/hidden.js');
  assert.equal(result.structuredContent.workspaceRoot, secretRoot);
});
