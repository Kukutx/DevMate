import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult, MODEL_VISIBLE_OPERATIONS } from '../runtime/mcp.mjs';

const require = createRequire(import.meta.url);
const { createVscodeRuntimeEntry } = require('../vscode-host/runtime-entry.cjs');
const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-editor-'));
  const root = path.join(temp, 'project'), other = path.join(temp, 'other');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true }); fs.mkdirSync(other);
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const windowId = randomUUID();
  const attached = await service.call('window.attach', { windowId, title: 'Fixture', roots: [{ root, name: 'Editor project', register: 'write' }] }, { ...owner, windowId });
  const present = async (name, input, context = owner) => presentResult(service.operations.get(name), await service.call(name, input, context)).content[0].text;
  return { service, root, other, windowId, projectId: attached.selectedProjectId, present };
}

test('a window publishes its editor state and the model reads it project-relative, without protected or foreign files', async t => {
  const { service, root, other, windowId, projectId, present } = await fixture(t);
  assert.match(await present('editor.diagnostics', { projectId }), /reports no diagnostics/);
  const file = name => path.join(root, name);
  const accepted = await service.call('window.context', { windowId, context: {
    active: { file: file('src/app.ts'), languageId: 'typescript', dirty: true, lineCount: 40,
      selection: { startLine: 9, startCharacter: 0, endLine: 11, endCharacter: 4 }, selectedText: 'const total = sum(items);' },
    open: [{ file: file('src/app.ts'), dirty: true }, { file: file('README.md') }, { file: file('.env') }, { file: path.join(other, 'elsewhere.ts') }],
    diagnostics: [
      { file: file('src/util.ts'), severity: 'hint', line: 0, character: 0, message: 'unused import' },
      { file: file('src/app.ts'), severity: 'warning', line: 4, character: 2, message: 'x is never reassigned', source: 'eslint', code: 'prefer-const' },
      { file: file('src/app.ts'), severity: 'error', line: 9, character: 14, message: "Cannot find name 'sum'.", source: 'ts', code: 2304 },
      { file: file('.env'), severity: 'error', line: 0, character: 0, message: 'SECRET=leak' },
      { file: path.join(other, 'elsewhere.ts'), severity: 'error', line: 0, character: 0, message: 'other project' }
    ] } }, { ...owner, windowId });
  assert.equal(accepted.diagnostics, 3, 'protected and out-of-project files are dropped before they are kept');
  const context = await service.call('editor.context', { projectId }, owner);
  assert.equal(context.active.path, 'src/app.ts'); assert.deepEqual(context.active.selection, { startLine: 10, startCharacter: 1, endLine: 12, endCharacter: 5 });
  assert.deepEqual(context.open, ['src/app.ts (unsaved)', 'README.md']);
  assert.deepEqual(context.diagnosticCounts, { error: 1, warning: 1, info: 0, hint: 1 });
  const shown = await present('editor.context', { projectId });
  assert.match(shown, /Active file: src\/app\.ts \(typescript\), unsaved changes/); assert.match(shown, /const total = sum\(items\);/); assert.match(shown, /1 error, 1 warning/);
  const listed = await present('editor.diagnostics', { projectId });
  assert.equal(listed, "src/app.ts:10:15 error [ts 2304] Cannot find name 'sum'.\nsrc/app.ts:5:3 warning [eslint prefer-const] x is never reassigned");
  assert.equal(listed.includes('SECRET'), false);
  assert.equal((await service.call('editor.diagnostics', { projectId, severity: 'hint' }, owner)).total, 3);
  assert.equal((await service.call('editor.diagnostics', { projectId, severity: 'error' }, owner)).total, 1);
  assert.equal((await service.call('editor.diagnostics', { projectId, path: 'src/util.ts', severity: 'hint' }, owner)).items[0].message, 'unused import');
  // Another window may only publish its own state, and a member needs a grant for the project.
  await assert.rejects(service.call('window.context', { windowId: randomUUID(), context: {} }, owner), { code: 'window_missing' });
  await assert.rejects(service.call('window.context', { windowId, context: {} }, { id: 'm', role: 'write', projectIds: [projectId] }), { code: 'forbidden' });
  await assert.rejects(service.call('editor.context', { projectId }, { id: 'm', role: 'read', projectIds: [] }), { code: 'forbidden' });
  await service.call('window.detach', { windowId }, { ...owner, windowId });
  assert.match(await present('editor.context', { projectId }), /No editor is attached to this project/);
  for (const name of ['editor.context', 'editor.diagnostics', 'project.overview']) assert.ok(MODEL_VISIBLE_OPERATIONS.has(name), name);
});

test('project overview orients a model in one call: scripts, instructions, layout, Git and editor state', async t => {
  const { service, root, projectId, present } = await fixture(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest run', build: 'tsc -p .' } }));
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), ''); fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Rules\nAlways run the tests.\n'); fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  const overview = await service.call('project.overview', { projectId: root }, owner);
  assert.equal(overview.id, projectId); assert.equal(overview.git, null); assert.equal(overview.scriptRunner, 'pnpm');
  assert.deepEqual(overview.scripts, { test: 'vitest run', build: 'tsc -p .' }); assert.deepEqual(overview.markers.sort(), ['Node.js', 'TypeScript']);
  assert.deepEqual(overview.instructions.map(item => item.path), ['AGENTS.md']); assert.equal(overview.entries.includes('.env'), false);
  const shown = await present('project.overview', { projectId });
  assert.match(shown, /Git: not a repository/); assert.match(shown, /Scripts \(pnpm run <name>\):\n {2}test: vitest run/);
  assert.match(shown, /--- AGENTS\.md ---\n# Rules\nAlways run the tests\./); assert.match(shown, /Editor: 0 error\(s\), 0 warning\(s\) reported/);
});

test('the VS Code host publishes the real editor state on attach and again when diagnostics change', async () => {
  const published = [], listeners = {};
  const root = process.cwd(), file = path.join(root, 'runtime', 'main.mjs');
  let running = false, diagnostics = [];
  const client = { start: async () => { running = true; }, stop: async () => { running = false; }, status: async () => ({ running, state: running ? 'ready' : 'stopped' }),
    snapshot: async () => ({}), operations: async () => ({ items: [] }), workbenchUrl: async () => 'http://127.0.0.1:1', dispose() {},
    subscribe: () => ({ dispose() {} }),
    call: async (name, input) => {
      if (name === 'window.attach') return { windowId: input.windowId, roots: input.roots.map(item => ({ ...item, projectId: 'project' })), selectedProjectId: 'project' };
      if (name === 'window.context') published.push(input);
      return {};
    } };
  const on = name => handler => { listeners[name] = handler; return { dispose() {} }; };
  const range = (line, character) => ({ start: { line, character }, end: { line, character: character + 3 } });
  const document = { uri: { scheme: 'file', fsPath: file }, languageId: 'javascript', isDirty: false, isClosed: false, lineCount: 300, getText: () => 'selected text' };
  const vscode = {
    TreeItem: class { constructor(label) { this.label = label; } }, TreeItemCollapsibleState: { None: 0 },
    EventEmitter: class { constructor() { this.event = () => {}; } fire() {} dispose() {} },
    workspace: { name: 'Window', isTrusted: true, workspaceFolders: [{ name: 'DevMate', uri: { scheme: 'file', fsPath: root } }],
      getConfiguration: () => ({ get: (_name, fallback) => fallback }), textDocuments: [document, { uri: { scheme: 'untitled', fsPath: 'Untitled-1' } }],
      onDidSaveTextDocument: on('save') },
    window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }), registerTreeDataProvider: () => ({ dispose() {} }),
      showErrorMessage: async message => { throw new Error(message); }, showWarningMessage: async () => undefined,
      activeTextEditor: { document, selection: { ...range(2, 4), isEmpty: false } }, onDidChangeActiveTextEditor: on('editor') },
    languages: { getDiagnostics: () => diagnostics, onDidChangeDiagnostics: on('diagnostics') },
    commands: { registerCommand: () => ({ dispose() {} }) }, env: { openExternal: async () => true }, Uri: { parse: value => value }
  };
  const commands = new Map(); vscode.commands.registerCommand = (id, handler) => { commands.set(id, handler); return { dispose() {} }; };
  const entry = createVscodeRuntimeEntry(vscode, { client });
  await entry.activate({ subscriptions: [] });
  assert.equal(published.length, 0, 'nothing is published while the runtime is stopped');
  await commands.get('devMate.runtime.start')();
  await delay(80);
  assert.equal(published.length, 1); assert.equal(published[0].windowId, entry.windowId);
  assert.deepEqual(published[0].context.active, { file, languageId: 'javascript', dirty: false, lineCount: 300,
    selection: { startLine: 2, startCharacter: 4, endLine: 2, endCharacter: 7 }, selectedText: 'selected text' });
  assert.deepEqual(published[0].context.open, [{ file, dirty: false }]);
  diagnostics = [[document.uri, [{ severity: 1, range: range(7, 0), message: 'later warning', source: 'eslint', code: { value: 'no-undef' } },
    { severity: 0, range: range(1, 2), message: 'an error', source: 'ts', code: 2304 }]], [{ scheme: 'git', fsPath: 'x' }, [{ severity: 0, range: range(0, 0), message: 'virtual' }]]];
  listeners.diagnostics(); listeners.diagnostics();
  await delay(800);
  assert.equal(published.length, 2, 'a burst of changes is published once');
  assert.deepEqual(published[1].context.diagnostics, [
    { file, severity: 'error', line: 1, character: 2, message: 'an error', source: 'ts', code: 2304 },
    { file, severity: 'warning', line: 7, character: 0, message: 'later warning', source: 'eslint', code: 'no-undef' }]);
  listeners.save(); await delay(450);
  assert.equal(published.length, 2, 'unchanged state is not sent again');
  await entry.deactivate();
});
