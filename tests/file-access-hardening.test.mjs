import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-file-access-hardening-'));
const workspace = path.join(root, 'workspace');
const configPath = path.join(root, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
const config = configStore.newInstanceConfig({ workspaceRoot: workspace, appVersion: configStore.DEFAULT_VERSION });
config.permissions.profile = 'fullAccess';
config.activeWorkspaceId = 'app';
config.workspaces = [{ id: 'app', name: 'Application', root: workspace, reference: false, mode: 'workspace-write', role: 'active' }];
configStore.atomicWriteJson(configPath, config);
process.env.DEVMATE_CONFIG = configPath;
process.env.DEVMATE_DISABLE_INSTANCE_LOCK = '1';

const policy = await import('../gateway/sensitive-path-policy.mjs');
const hardening = await import('../gateway/file-access-hardening.mjs');
const snapshot = await import('../gateway/agent-snapshot.mjs');

const principalWorkspace = { id: 'app', name: 'Application', root: workspace, reference: false, mode: 'workspace-write', role: 'active' };

async function write(rel, content = 'needle\n') {
  const file = path.join(workspace, ...rel.split('/'));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
  return file;
}

test.beforeEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
  await fsp.mkdir(workspace, { recursive: true });
});

test('credential-prone workspace paths are classified without blocking safe examples', () => {
  for (const rel of [
    '.npmrc', '.pypirc', '.netrc', '.dev.vars', '.aws/credentials', '.ssh/id_ed25519',
    '.kube/config', '.terraform/terraform.tfstate', '.docker/config.json', 'keys/release.p12', 'logs/runtime.log'
  ]) {
    assert.equal(policy.isSensitiveWorkspacePath(rel), true, rel);
  }
  for (const rel of ['.env.example', '.env.sample', '.docker/Dockerfile', 'src/config.json', 'gradle/wrapper/gradle-wrapper.properties']) {
    assert.equal(policy.isSensitiveWorkspacePath(rel), false, rel);
  }
  assert.equal(policy.isSafeWorkspaceTextPath('.env.example'), true);
  assert.equal(policy.isSafeWorkspaceTextPath('.docker/Dockerfile'), true);
});

test('explicit read and mutation paths fail closed before reaching their handlers', () => {
  for (const [name, args] of [
    ['read_file', { path: '.npmrc' }],
    ['write_file', { path: '.dev.vars' }],
    ['delete_file', { path: '.aws/credentials' }],
    ['apply_patch', { filePath: '.docker/config.json' }],
    ['move_file', { from: 'src/app.js', to: '.kube/config' }]
  ]) {
    assert.throws(() => hardening.__test.guardExplicitPaths(name, args), error => error?.code === 'sensitive_workspace_path');
  }
  assert.doesNotThrow(() => hardening.__test.guardExplicitPaths('read_file', { path: 'src/app.js' }));
});

test('secure search omits credential directories and Docker auth while retaining normal project files', async () => {
  await write('src/app.js', 'const marker = "needle";\n');
  await write('config/visible.json', '{"marker":"needle"}\n');
  await write('.aws/cache.json', '{"secret":"needle"}\n');
  await write('.docker/config.json', '{"auths":{"needle":"secret"}}\n');
  await write('.docker/Dockerfile', '# needle\nFROM scratch\n');
  await write('.npmrc', '//registry.example/:_authToken=needle\n');

  const result = await hardening.__test.safeSearchText({ workspaceId: 'app', query: 'needle', maxResults: 20 });
  const files = result.structuredContent.results.map(item => item.file).sort();
  assert.deepEqual(files, ['.docker/Dockerfile', 'config/visible.json', 'src/app.js']);
  assert.equal(files.some(file => policy.isSensitiveWorkspacePath(file)), false);
});

test('recursive directory mutation refuses a safe parent that contains protected credentials', async () => {
  await write('bundle/src/app.js', 'export const ok = true;\n');
  await write('bundle/.kube/config', 'token: secret\n');
  await assert.rejects(
    hardening.__test.assertNoSensitiveDescendants(principalWorkspace, 'bundle'),
    error => error?.code === 'sensitive_workspace_path' && /bundle[\\/].kube[\\/]config/.test(error.message)
  );
});

test('workspace root remains readable while symlink escape is rejected when supported', async t => {
  assert.equal(hardening.__test.safeWorkspacePath(principalWorkspace, '.'), path.resolve(workspace));
  const outside = path.join(root, 'outside');
  await fsp.mkdir(outside, { recursive: true });
  const link = path.join(workspace, 'escape');
  try {
    await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('symlink creation unavailable');
    return;
  }
  assert.throws(() => hardening.__test.safeWorkspacePath(principalWorkspace, 'escape'), /symlink|reparse/i);
});

test('path-bearing discovery and editor context results remove protected entries', () => {
  const listed = {
    structuredContent: {
      items: [
        { type: 'file', path: 'src/app.js' },
        { type: 'file', path: '.docker/config.json' },
        { type: 'dir', path: '.aws' }
      ]
    },
    content: [{ type: 'text', text: '{}' }]
  };
  hardening.__test.filterPathResults('list_files', listed);
  assert.deepEqual(listed.structuredContent.items, [{ type: 'file', path: 'src/app.js' }]);

  const context = {
    structuredContent: {
      activeEditor: { path: '.env', languageId: 'dotenv' },
      visibleEditors: [{ path: 'src/app.js' }, { path: '.aws/credentials' }],
      diagnostics: [{ path: '.kube/config' }, { path: 'src/app.js' }]
    },
    content: [{ type: 'text', text: '{}' }]
  };
  hardening.__test.filterPathResults('vscode_context', context);
  assert.equal(context.structuredContent.activeEditor, null);
  assert.deepEqual(context.structuredContent.visibleEditors, [{ path: 'src/app.js' }]);
  assert.deepEqual(context.structuredContent.diagnostics, [{ path: 'src/app.js' }]);
});

test('Codex snapshot remains at least as strict for representative credential paths', () => {
  for (const rel of ['.npmrc', '.pypirc', '.netrc', '.aws/credentials', '.docker/config.json', '.kube/config', 'keys/release.p12']) {
    assert.equal(snapshot.proposalTextPath(rel), false, rel);
  }
  assert.equal(snapshot.proposalTextPath('.env.example'), true);
  assert.equal(snapshot.proposalTextPath('src/app.js'), true);
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  delete process.env.DEVMATE_DISABLE_INSTANCE_LOCK;
  await fsp.rm(root, { recursive: true, force: true });
});
