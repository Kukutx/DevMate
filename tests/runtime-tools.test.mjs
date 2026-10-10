import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, offerTool, recallTools, resolveTool, __test } from '../runtime/platform/tools.mjs';
import { DevMateService } from '../runtime/service.mjs';

const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const executable = name => name + (process.platform === 'win32' ? '.exe' : '');

test('an editor\'s own ripgrep is used only when PATH has none, only while it exists, and is remembered for a start without an editor', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tools-'));
  t.after(() => { __test.forget(); fs.rmSync(temp, { recursive: true, force: true }); });
  __test.forget();
  const editor = path.join(temp, 'editor'), onPath = path.join(temp, 'bin'), instance = path.join(temp, 'instance');
  for (const directory of [editor, onPath, instance]) fs.mkdirSync(directory);
  const bundled = path.join(editor, executable('rg'));
  fs.writeFileSync(bundled, ''); fs.writeFileSync(path.join(editor, executable('other')), ''); fs.writeFileSync(path.join(onPath, executable('rg')), '');
  const nothing = { PATH: path.join(temp, 'empty') };
  assert.throws(() => resolveTool('rg', nothing), error => error.code === 'tool_missing' && /ripgrep/.test(error.message) && /restart DevMate/.test(error.message),
    'the message says how to get it and that a restart is needed');
  // Only ripgrep, only an absolute path to a file that is there and is named like the tool.
  assert.equal(offerTool('git', path.join(editor, executable('rg'))), false);
  assert.equal(offerTool('rg', executable('rg')), false);
  assert.equal(offerTool('rg', path.join(editor, executable('other'))), false);
  assert.equal(offerTool('rg', path.join(editor, 'missing', executable('rg'))), false);
  assert.equal(offerTool('rg', editor), false);
  assert.throws(() => resolveTool('rg', nothing), { code: 'tool_missing' });
  assert.equal(offerTool('rg', bundled, instance), true);
  assert.equal(resolveTool('rg', nothing), bundled);
  assert.equal(resolveTool('rg', { PATH: onPath }), path.join(onPath, executable('rg')), 'a ripgrep the user installed comes first');
  // A later start with no editor open still knows the copy.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(instance, 'tools.json'), 'utf8')), { rg: bundled });
  __test.forget();
  assert.throws(() => resolveTool('rg', nothing), { code: 'tool_missing' });
  recallTools(instance);
  assert.equal(resolveTool('rg', nothing), bundled);
  // An editor update removes the old copy: it is not used any more, and nothing is invented.
  fs.rmSync(bundled);
  assert.throws(() => resolveTool('rg', nothing), { code: 'tool_missing' });
  __test.forget();
  recallTools(instance);
  assert.throws(() => resolveTool('rg', nothing), { code: 'tool_missing' });
  fs.writeFileSync(path.join(instance, 'tools.json'), '{ not json');
  assert.doesNotThrow(() => recallTools(instance));
  assert.doesNotThrow(() => recallTools(path.join(temp, 'no-such-instance')));
});

test('with no ripgrep on PATH, finding files works once an editor window has attached, and only a local host can offer the copy', async t => {
  const real = findOnPath('rg');
  if (!real) return t.skip('ripgrep is not installed on this computer');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tools-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'note.txt'), 'hello\n');
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  const savedPath = process.env.PATH, pathName = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') || 'PATH';
  t.after(async () => { process.env[pathName] = savedPath; __test.forget(); await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = await service.call('project.create', { root }, owner);
  __test.forget();
  process.env[pathName] = path.join(temp, 'empty');
  await assert.rejects(service.call('workspace.find', { projectId: project.id, pattern: '*.txt' }, owner), { code: 'tool_missing' });
  const window = { windowId: '6f1c1f0e-1d8f-4a55-9d0f-3a6f1f2b9c11', title: 'Editor', roots: [{ root, name: 'project' }], tools: { rg: real } };
  // A connected model or member cannot point DevMate at a program of its choosing.
  await assert.rejects(service.call('window.attach', window, { id: 'owner', role: 'owner', surface: 'mcp' }), { code: 'forbidden' });
  await assert.rejects(service.call('window.attach', window, { id: 'member', role: 'write', projectIds: [project.id], surface: 'local' }), { code: 'forbidden' });
  await assert.rejects(service.call('workspace.find', { projectId: project.id, pattern: '*.txt' }, owner), { code: 'tool_missing' });
  await assert.rejects(service.call('window.attach', { ...window, tools: { rg: real, git: real } }, owner), { code: 'invalid_input' });
  const attached = await service.call('window.attach', window, owner);
  assert.equal(attached.roots[0].projectId, project.id);
  const found = async () => (await service.call('workspace.find', { projectId: project.id, pattern: '*.txt' }, owner)).items.map(item => item.path);
  assert.deepEqual(await found(), ['note.txt']);
  assert.equal((await service.call('workspace.search', { projectId: project.id, query: 'hello' }, owner)).items[0].path, 'note.txt');
  const check = (await service.call('runtime.doctor', {}, owner)).checks.find(item => item.id === 'rg');
  assert.equal(check.status, 'ok'); assert.ok(check.detail.includes(real)); assert.match(check.detail, /ships with your editor/);
  await service.call('window.detach', { windowId: window.windowId }, owner);
  assert.deepEqual(await found(), ['note.txt'], 'the copy stays known after the editor closes');
});
