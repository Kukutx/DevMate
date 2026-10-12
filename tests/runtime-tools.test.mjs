import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, offerTool, recallTools, resolveTool, startable, __test } from '../runtime/platform/tools.mjs';
import { detectShell } from '../runtime/shell.mjs';
import { findExecutable } from '../runtime/engines/engine-io.mjs';
import { DevMateService } from '../runtime/service.mjs';

const owner = Object.freeze({ id: 'owner', surface: 'local' });
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

test('a program Windows keeps on PATH as an app execution alias is found and started; a name that cannot be asked about never ends the search', t => {
  // What `winget install --id Microsoft.PowerShell` leaves, the command the doctor gives: pwsh.exe in
  // %LOCALAPPDATA%\Microsoft\WindowsApps, a link only Windows follows. Asked about as a file it is refused (EACCES),
  // and started it runs. The search threw there, and the runtime did not start on a computer that had followed the
  // doctor's own advice.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-tools-'));
  const apps = path.join(temp, 'apps'), bin = path.join(temp, 'bin'), alias = path.join(apps, executable('pwsh')), later = path.join(bin, executable('pwsh'));
  for (const directory of [apps, bin]) fs.mkdirSync(directory);
  for (const file of [alias, later]) fs.writeFileSync(file, '');
  const stat = fs.statSync, lstat = fs.lstatSync, readlink = fs.readlinkSync, real = fs.realpathSync.native;
  const pathName = Object.keys(process.env).find(name => name.toUpperCase() === 'PATH') || 'PATH', savedPath = process.env[pathName];
  const restore = () => { fs.statSync = stat; fs.lstatSync = lstat; fs.readlinkSync = readlink; fs.realpathSync.native = real; process.env[pathName] = savedPath; };
  t.after(() => { restore(); fs.rmSync(temp, { recursive: true, force: true }); });
  const refused = file => Object.assign(new Error('EACCES: permission denied, stat \'' + file + '\''), { code: 'EACCES', path: file });
  let target = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe';
  // (Windows does not tell pwsh.EXE from pwsh.exe, and a search by the extensions of PATHEXT asks for the first.)
  const same = file => process.platform === 'win32' ? String(file).toLowerCase() === alias.toLowerCase() : file === alias;
  fs.statSync = (file, ...rest) => { if (same(file)) throw refused(file); return stat(file, ...rest); };
  fs.lstatSync = (file, ...rest) => same(file) ? { isSymbolicLink: () => true, isFile: () => false } : lstat(file, ...rest);
  fs.readlinkSync = (file, ...rest) => same(file) ? target : readlink(file, ...rest);
  fs.realpathSync.native = (file, ...rest) => { if (same(file)) throw refused(file); return real(file, ...rest); };
  const env = { PATH: [apps, bin].join(path.delimiter) };
  // (An engine looks for its programs on the PATH of the runtime itself.)
  process.env[pathName] = env.PATH;
  if (process.platform === 'win32') {
    assert.equal(startable(alias), true);
    assert.equal(findOnPath('pwsh', env), alias); assert.equal(findOnPath(alias, env), alias);
    assert.deepEqual(detectShell(env, 'win32'), { kind: 'powershell', file: alias, label: 'PowerShell 7' });
    // An engine starts it by that name as well: the file behind it cannot be started, nor asked for.
    assert.equal(findExecutable(['pwsh']).toLowerCase(), alias.toLowerCase()); assert.equal(findExecutable([alias]), alias);
    // The names Windows keeps for Python where none is installed are no Python: they open the Store.
    target = 'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe\\AppInstallerPythonRedirector.exe';
    assert.equal(startable(alias), false); assert.equal(findOnPath('pwsh', env), later); assert.equal(findExecutable(['pwsh']), real(later));
  } else {
    // Elsewhere a name that is refused is no program, and what comes later on PATH is.
    assert.equal(startable(alias), false); assert.equal(findOnPath('pwsh', env), later); assert.equal(findExecutable(['pwsh']), real(later));
  }
  // A name that can be asked about in no way is no program on any system, and the search goes on past it.
  fs.lstatSync = (file, ...rest) => { if (same(file)) throw refused(file); return lstat(file, ...rest); };
  assert.equal(startable(alias), false); assert.equal(findOnPath('pwsh', env), later); assert.equal(findOnPath(alias, env), null);
  assert.equal(findExecutable(['pwsh']), real(later)); assert.equal(findExecutable([alias]), null);
  restore();
  // A runtime that is started from that PowerShell has the folder of the package first on its PATH, a folder with
  // the version in its name, which the next update takes away. The name that stays is what the shell is started by.
  if (process.platform === 'win32') {
    const versioned = path.join(temp, 'WindowsApps', 'Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe'), kept = path.join(temp, 'Microsoft', 'WindowsApps');
    for (const directory of [versioned, kept]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(versioned, 'pwsh.exe'), '');
    const started = { PATH: [versioned, kept].join(path.delimiter), LOCALAPPDATA: temp };
    assert.equal(detectShell(started, 'win32').file, path.join(versioned, 'pwsh.exe'), 'where there is no such name, the file that was found');
    fs.writeFileSync(path.join(kept, 'pwsh.exe'), '');
    assert.equal(detectShell(started, 'win32').file, path.join(kept, 'pwsh.exe'));
    assert.equal(detectShell({ PATH: bin }, 'win32').file, later, 'a PowerShell that is no package is started where it is');
  }
  // Where this computer has such names for real: the PowerShell 7 that winget installed is a program, and the
  // python.exe Windows keeps where the Store's installer is all there is behind it is none.
  const apps7 = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : null;
  for (const [name, expected] of apps7 ? [['pwsh.exe', true], ['python.exe', false]] : []) {
    const installed = path.join(apps7, name);
    let behind = null;
    try { if (fs.lstatSync(installed).isSymbolicLink()) behind = fs.readlinkSync(installed); } catch {}
    if (behind && /AppInstallerPythonRedirector\.exe$/i.test(behind) !== expected) assert.equal(startable(installed), expected, installed + ' -> ' + behind);
  }
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
  // A connected client cannot point DevMate at a program of its choosing.
  await assert.rejects(service.call('window.attach', window, { id: 'owner', surface: 'mcp' }), { code: 'forbidden' });
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
