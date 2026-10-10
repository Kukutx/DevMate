import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../runtime/store.mjs';
import { createWorkspaceService } from '../runtime/workspace.mjs';
import { createProcessManager } from '../runtime/processes.mjs';
import { detectShell } from '../runtime/shell.mjs';
import { findOnPath, resolveTool } from '../runtime/platform/tools.mjs';

const node = process.execPath;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function fixture(t, settings = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-safety-'));
  const root = path.join(temp, 'project'), controlRoot = path.join(temp, 'instance');
  fs.mkdirSync(root);
  const store = new Store(controlRoot);
  const service = createWorkspaceService({ store });
  const register = (directory, extra = {}) => ({ ...store.create('project', { root: directory, name: path.basename(directory), access: 'write', status: 'ready', ...extra }), controlRoot });
  const project = register(root, settings);
  t.after(() => { store.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { temp, root, project, service, store, register, file: name => path.join(root, name) };
}
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('the Git tools never run a program the repository defines and never read a protected file out of history', async t => {
  const { project, service, file, root, temp } = fixture(t);
  git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(file('a.txt'), 'first\n'); fs.writeFileSync(file('.env'), 'SECRET=one\n');
  git(root, 'add', '-f', '--', 'a.txt', '.env'); git(root, 'commit', '--quiet', '-m', 'first commit');
  // The repository asks Git to run a program whenever a text file is shown or compared.
  const marker = path.join(temp, 'ran.txt'), trap = path.join(temp, 'trap.js');
  fs.writeFileSync(trap, "require('fs').appendFileSync(" + JSON.stringify(marker) + ", 'ran\\n');process.stdout.write(require('fs').readFileSync(process.argv[2]||0));");
  const program = JSON.stringify(node.replaceAll('\\', '/')) + ' ' + JSON.stringify(trap.replaceAll('\\', '/'));
  git(root, 'config', 'diff.evil.textconv', program); git(root, 'config', 'filter.evil.clean', program); git(root, 'config', 'filter.evil.smudge', program);
  fs.writeFileSync(file('.gitattributes'), '*.txt diff=evil filter=evil\n');
  fs.writeFileSync(file('a.txt'), 'first\nsecond\n');
  // The trap is real: plain Git, as a person would run it, executes the program.
  spawnSync('git', ['diff'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(fs.existsSync(marker), true, 'the fixture really triggers repository-defined programs');
  fs.rmSync(marker);
  const diff = await service.gitDiff(project);
  assert.match(diff.stdout, /\+second/);
  await service.gitStatus(project); await service.gitLog(project, {}); await service.gitShow(project, {});
  await service.gitBlame(project, { path: 'a.txt' }); await service.gitBranches(project); await service.gitDiff(project, { staged: true });
  assert.equal(fs.existsSync(marker), false, 'no DevMate Git tool ran it');
  // A revision that names a file is a way to read that file; only commits are accepted.
  for (const ref of ['HEAD:.env', ':.env', 'HEAD:a.txt', 'main:.env']) await assert.rejects(service.gitShow(project, { ref }), error => ['invalid_input', 'not_found'].includes(error.code), ref);
  await assert.rejects(service.gitBlame(project, { path: '.env' }), { code: 'protected_workspace_path' });
  await assert.rejects(service.gitLog(project, { paths: ['.env'] }), { code: 'protected_workspace_path' });
  const shown = await service.gitShow(project, { ref: 'HEAD' });
  assert.match(shown.stdout, /first commit/); assert.equal(shown.stdout.includes('SECRET'), false);
  assert.equal(path.isAbsolute(resolveTool('git')), true, 'Git is started by its absolute path, never by a name the project could shadow');
  assert.equal(findOnPath('git', { PATH: root }), null);
});

test('a deleted directory is restorable file by file; one too large to keep needs an explicit force', async t => {
  const { project, service, file } = fixture(t);
  service.write(project, { path: 'docs/guide/intro.md', text: 'intro' });
  service.write(project, { path: 'docs/notes.md', text: 'notes' });
  assert.throws(() => service.remove(project, { path: 'docs' }), error => error.code === 'directory_not_empty' && /2 file\(s\)/.test(error.message));
  const removed = service.remove(project, { path: 'docs', recursive: true });
  assert.deepEqual([removed.type, removed.files, removed.restorableFiles, removed.restorable], ['directory', 2, 2, true]);
  assert.equal(fs.existsSync(file('docs')), false);
  // Without a path the history is the project's: every recent change, each file under its own name.
  const recent = service.history(project, {}).items;
  const lost = recent.filter(item => item.action === 'removed' && !item.directory);
  assert.deepEqual(lost.map(item => item.path).sort(), ['docs/guide/intro.md', 'docs/notes.md']);
  assert.ok(lost.every(item => item.previousRestorable));
  service.restore(project, { path: 'docs/guide/intro.md', sha256: lost.find(item => item.path === 'docs/guide/intro.md').previousSha256 });
  assert.equal(fs.readFileSync(file('docs/guide/intro.md'), 'utf8'), 'intro');
  fs.mkdirSync(file('generated'));
  for (let index = 0; index < 2001; index++) fs.writeFileSync(file('generated/f' + index), '');
  assert.throws(() => service.remove(project, { path: 'generated', recursive: true }), error => error.code === 'too_large_to_keep' && /force:true/.test(error.message));
  assert.equal(fs.existsSync(file('generated/f0')), true, 'nothing was deleted by the refused call');
  const forced = service.remove(project, { path: 'generated', recursive: true, force: true });
  assert.deepEqual([forced.files, forced.restorableFiles, forced.restorable], [2001, 0, false]);
  // A directory that holds a credential-like file is never deleted or moved as a whole.
  service.write(project, { path: 'app/code.js', text: 'x' }); fs.writeFileSync(file('app/.env'), 'SECRET=1');
  assert.throws(() => service.remove(project, { path: 'app', recursive: true, force: true }), { code: 'protected_content' });
  assert.throws(() => service.move(project, { from: 'app', to: 'moved' }), { code: 'protected_content' });
  assert.equal(fs.readFileSync(file('app/.env'), 'utf8'), 'SECRET=1');
});

test('history keeps no bytes that belong outside the project, and a version is restorable only where it was recorded', async t => {
  const { project, service, file, temp, register } = fixture(t);
  const outside = path.join(temp, 'outside.txt');
  fs.writeFileSync(outside, 'belongs elsewhere');
  fs.linkSync(outside, file('alias.txt'));
  const removed = service.remove(project, { path: 'alias.txt' });
  assert.deepEqual([removed.removed, removed.restorable], [true, false], 'a hard link is removed without copying the shared content');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'belongs elsewhere');
  const first = service.write(project, { path: 'plan.md', text: 'private plan' });
  service.write(project, { path: 'plan.md', text: 'changed', expectedSha256: first.sha256 });
  const otherRoot = path.join(temp, 'other'); fs.mkdirSync(otherRoot);
  const other = register(otherRoot);
  assert.throws(() => service.restore(other, { path: 'stolen.md', sha256: first.sha256 }), { code: 'not_found' });
  assert.equal(fs.existsSync(path.join(otherRoot, 'stolen.md')), false);
  assert.equal(service.restore(project, { path: 'plan.md', sha256: first.sha256 }).written, true);
  assert.deepEqual(service.history(other, {}).items, []);
});

test('edits keep a byte-order mark and the line endings a file has', async t => {
  const { project, service, file } = fixture(t);
  fs.writeFileSync(file('script.ps1'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('$a = 1\r\n$b = 2\r\n')]));
  assert.equal(service.read(project, { path: 'script.ps1' }).text, '$a = 1\r\n$b = 2\r\n'.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  service.edit(project, { path: 'script.ps1', edits: [{ oldText: '$a = 1\n$b = 2', newText: '$a = 10\n$b = 20' }] });
  const bytes = fs.readFileSync(file('script.ps1'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the mark Windows PowerShell needs is still there');
  assert.equal(bytes.subarray(3).toString('utf8'), '$a = 10\r\n$b = 20\r\n');
  // Exact text is tried first, so a file with mixed endings is edited as it is.
  fs.writeFileSync(file('mixed.txt'), 'one\r\ntwo\nthree\n');
  service.edit(project, { path: 'mixed.txt', edits: [{ oldText: 'two\nthree', newText: 'TWO\nTHREE' }] });
  assert.equal(fs.readFileSync(file('mixed.txt'), 'utf8'), 'one\r\nTWO\nTHREE\n');
});

test('credential protection is a per-project choice; control storage and links stay out either way', async t => {
  const { project, service, file, root, temp, register } = fixture(t);
  fs.writeFileSync(file('.env'), 'TOKEN=needle'); fs.writeFileSync(file('app.js'), 'needle');
  assert.throws(() => service.read(project, { path: '.env' }), { code: 'protected_workspace_path' });
  assert.deepEqual(service.files(project).items.map(item => item.name), ['app.js']);
  assert.deepEqual((await service.search(project, { query: 'needle' })).items.map(item => item.path), ['app.js']);
  // The owner may switch protection off for a project where these files are the work.
  const open = { ...project, protectSecrets: false };
  assert.equal(service.read(open, { path: '.env' }).text, 'TOKEN=needle');
  assert.deepEqual(service.files(open).items.map(item => item.name), ['.env', 'app.js']);
  assert.deepEqual((await service.search(open, { query: 'needle' })).items.map(item => item.path).sort(), ['.env', 'app.js']);
  service.edit(open, { path: '.env', edits: [{ oldText: 'needle', newText: 'changed' }] });
  assert.equal(fs.readFileSync(file('.env'), 'utf8'), 'TOKEN=changed');
  fs.mkdirSync(file('.git')); fs.writeFileSync(file('.git/config'), '[core]');
  assert.equal(service.files(open).items.some(item => item.name === '.git'), false, 'repository internals are never listed');
  const outside = path.join(temp, 'elsewhere'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'data.txt'), 'outside');
  fs.symlinkSync(outside, file('link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => service.read(open, { path: 'link/data.txt' }));
  assert.throws(() => service.write(open, { path: 'link/new.txt', text: 'x' }));
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  // A project directory that is later swapped for a link is refused as a whole.
  const swapped = path.join(temp, 'swapped'); fs.mkdirSync(swapped);
  const victim = register(swapped);
  fs.rmdirSync(swapped); fs.symlinkSync(outside, swapped, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => service.read(victim, { path: 'data.txt' }), { code: 'unsafe_root' });
  assert.throws(() => service.write(victim, { path: 'planted.txt', text: 'x' }), { code: 'unsafe_root' });
  assert.equal(fs.existsSync(path.join(outside, 'planted.txt')), false);
  assert.equal(root, project.root);
});

test('a rename that only changes letter case works, and moves create the folders they need', { skip: process.platform !== 'win32' && process.platform !== 'darwin' && 'case-insensitive filesystems only' }, async t => {
  const { project, service, root } = fixture(t);
  service.write(project, { path: 'readme.md', text: 'hello' });
  assert.deepEqual(service.move(project, { from: 'readme.md', to: 'README.md' }), { from: 'readme.md', to: 'README.md', type: 'file' });
  assert.deepEqual(fs.readdirSync(root), ['README.md']);
  service.move(project, { from: 'README.md', to: 'docs/new/README.md' });
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'new', 'README.md'), 'utf8'), 'hello');
});

function processes(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-exec-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const manager = createProcessManager({ instanceRoot: path.join(temp, 'instance'), store: { event() {} } });
  t.after(async () => { await manager.close().catch(() => {}); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, manager, project: { id: 'project-test', root, access: 'write' } };
}

test('the shell reports success and failure the way the command meant them', { skip: detectShell().kind !== 'powershell' && 'PowerShell semantics' }, async t => {
  const { manager, project } = processes(t);
  // Programs such as git and npm write progress to stderr and still succeed.
  const noisy = await manager.run(project, { command: "node -e \"console.error('progress on stderr'); console.log('done')\"" });
  assert.equal(noisy.exitCode, 0, noisy.output); assert.match(noisy.output, /progress on stderr/); assert.match(noisy.output, /done/);
  assert.equal(noisy.output.includes('CLIXML'), false); assert.equal(noisy.output.includes('NativeCommandError'), false, 'errors are plain text, not a serialized object dump');
  assert.equal((await manager.run(project, { command: 'node -e "process.exit(3)"' })).exitCode, 3);
  assert.equal((await manager.run(project, { command: 'Get-Item definitely-missing-file' })).exitCode, 1, 'a failing last statement fails the command');
  assert.equal((await manager.run(project, { command: "Get-Item definitely-missing-file -ErrorAction SilentlyContinue\nWrite-Output 'recovered'" })).exitCode, 0);
  const unicode = await manager.run(project, { command: "Write-Output '中文 ✓ émoji'" });
  assert.equal(unicode.output.trim(), '中文 ✓ émoji');
  // A trailing line continuation cannot swallow the exit-code epilogue.
  assert.equal((await manager.run(project, { command: "Write-Output 'tail' `" })).output.includes('tail'), true);
});

test('giving up on a wait never ends the command; access removal ends exactly that caller\'s commands', async t => {
  const { manager, project } = processes(t);
  const controller = new AbortController();
  const pending = manager.run(project, { file: node, args: ['-e', "console.log('started');setInterval(()=>{},1000)"], waitMs: 60000, caller: 'member-a' }, { signal: controller.signal });
  await delay(500); controller.abort();
  const cancelled = await pending;
  assert.equal(cancelled.status, 'running', 'the request stopped waiting');
  assert.equal(alive(cancelled.pid), true, 'the command it started is still there to be read or stopped');
  const owners = await manager.run(project, { file: node, args: ['-e', 'setInterval(()=>{},1000)'], waitMs: 0, caller: 'owner' });
  await manager.stopForCaller('member-a');
  await delay(200);
  assert.equal(alive(cancelled.pid), false); assert.equal(alive(owners.pid), true);
  assert.equal(manager.list(project.id).items.find(item => item.id === cancelled.id).status, 'stopped');
  await manager.stop({ id: owners.id });
});

test('a bare program name is resolved on PATH, never in the project, and a finished stdin stays finished', async t => {
  const { manager, project, root } = processes(t);
  const version = await manager.run(project, { file: 'node', args: ['-p', 'process.version'] });
  assert.equal(version.output.trim(), process.version);
  // A program planted in the project under a well-known name is not what runs.
  fs.copyFileSync(node, path.join(root, process.platform === 'win32' ? 'git.exe' : 'git'));
  const real = await manager.run(project, { file: 'git', args: ['--version'] });
  assert.match(real.output, /^git version /, real.output);
  await assert.rejects(manager.run(project, { file: 'definitely-not-an-installed-program', args: [] }), error => error.code === 'command_not_found' && /Use command text/.test(error.message));
  const reader = await manager.run(project, { file: node, interactive: true, waitMs: 0, args: ['-e', "let t='';process.stdin.on('data',d=>t+=d).on('end',()=>{console.log('read:'+t.trim());})"] });
  manager.write({ id: reader.id, input: 'last line\n', end: true });
  assert.throws(() => manager.write({ id: reader.id, input: 'too late\n' }), { code: 'stdin_closed' });
  let state = await manager.read({ id: reader.id, cursor: 0, waitMs: 5000 });
  while (state.status === 'running') state = await manager.read({ id: reader.id, cursor: state.cursor, waitMs: 5000 });
  assert.equal((await manager.read({ id: reader.id, cursor: 0 })).output.trim(), 'read:last line');
});

test('a command that leaves something running in the background still reports its own exit, and stop says what it cannot reach', async t => {
  const { manager, project, root } = processes(t);
  const marker = path.join(root, 'orphan.pid');
  // The command starts a child that inherits its output pipe and outlives it.
  const source = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>console.log(String.fromCharCode(115,116,105,108,108)),200)'],{stdio:['ignore','inherit','inherit'],detached:true});" +
    "require('node:fs').writeFileSync(process.argv[1],String(c.pid));c.unref();console.log('parent done');";
  const started = Date.now();
  const result = await manager.run(project, { file: node, args: ['-e', source, marker], waitMs: 20000 });
  const orphan = Number(fs.readFileSync(marker, 'utf8'));
  t.after(() => { try { process.kill(orphan, 'SIGKILL'); } catch {} });
  assert.ok(Date.now() - started < 10000, 'the exit is noticed without waiting for the background child');
  assert.deepEqual([result.status, result.exitCode, result.backgroundOutput], ['exited', 0, true]);
  assert.match(result.output, /parent done/);
  const later = await manager.read({ id: result.id, cursor: result.cursor, waitMs: 3000 });
  assert.match(later.output, /still/, 'what the background child prints is still collected');
  await assert.rejects(manager.stop({ id: result.id }), error => error.code === 'background_processes' && /not tracked/.test(error.message));
  assert.equal(alive(orphan), true, 'nothing was claimed to be stopped');
});

test('a process tree that does not end is asked again, and an unconfirmed stop is an error, never a success', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-stubborn-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  let attempts = 0, giveUpAfter = 2;
  const manager = createProcessManager({ instanceRoot: path.join(temp, 'instance'), store: { event() {} },
    terminateImpl: async child => {
      if (++attempts <= giveUpAfter) return { exitConfirmed: false };
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL'); await exited;
      return { exitConfirmed: true };
    } });
  const project = { id: 'project-test', root, access: 'write' };
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await delay(300); await manager.close().catch(() => {});
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const first = await manager.run(project, { file: node, args: ['-e', 'setInterval(()=>{},1000)'], waitMs: 0 }); pids.push(first.pid);
  assert.equal((await manager.stop({ id: first.id })).status, 'stopped'); assert.equal(attempts, 3, 'the third request ended it');
  attempts = 0; giveUpAfter = Infinity;
  const stubborn = await manager.run(project, { file: node, args: ['-e', 'setInterval(()=>{},1000)'], waitMs: 0 }); pids.push(stubborn.pid);
  await assert.rejects(manager.stop({ id: stubborn.id }), error => error.code === 'shutdown_unconfirmed' && error.message.includes(String(stubborn.pid)));
  assert.equal(attempts, 3); assert.equal(manager.list(project.id).items.find(item => item.id === stubborn.id).status, 'running', 'it is still shown as running, because it is');
});

test('what Git reports but DevMate cannot address is left out of the status instead of failing it; reused versions stay fresh', async t => {
  const { project, service, file, root, temp } = fixture(t);
  git(root, 'init', '--quiet', '--initial-branch=main');
  fs.writeFileSync(file('tracked.txt'), 'one\n');
  const outside = path.join(temp, 'elsewhere'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'x.txt'), 'x');
  fs.symlinkSync(outside, file('linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = await service.gitStatus(project);
  assert.deepEqual(status.items.map(item => item.path), ['tracked.txt'], 'the link is not listed, and the call did not fail');
  assert.equal((await service.gitDiff(project)).exitCode, 0);
  // A kept version that is needed again counts as used now, so retention by age cannot remove what is still referenced.
  const first = service.write(project, { path: 'notes.md', text: 'one' });
  const second = service.write(project, { path: 'notes.md', text: 'two', expectedSha256: first.sha256 });
  const history = path.join(project.controlRoot, 'history');
  const blob = fs.readdirSync(history, { recursive: true }).map(name => path.join(history, name)).find(name => fs.statSync(name).isFile() && fs.readFileSync(name, 'utf8') === 'one');
  const old = new Date(Date.now() - 25 * 86400000); fs.utimesSync(blob, old, old);
  service.write(project, { path: 'notes.md', text: 'one', expectedSha256: second.sha256 });
  service.write(project, { path: 'notes.md', text: 'three', expectedSha256: first.sha256 });
  assert.ok(Date.now() - fs.statSync(blob).mtimeMs < 60000, 'the version was touched when it was kept again');
});

test('a large file that is deleted comes back byte for byte; one too large to keep is deleted only on an explicit force', async t => {
  const { project, service, file } = fixture(t);
  // Larger than a text file may be, so it is copied to history in one streamed pass.
  const large = Buffer.alloc(9 * 1024 * 1024 + 123);
  for (let offset = 0; offset < large.length; offset += 4096) large.writeUInt32LE(offset, offset);
  fs.writeFileSync(file('assets.bin'), large);
  const removed = service.remove(project, { path: 'assets.bin' });
  assert.deepEqual([removed.removed, removed.restorable, typeof removed.previousSha256], [true, true, 'string']);
  assert.equal(fs.existsSync(file('assets.bin')), false);
  const entry = service.history(project, { path: 'assets.bin' }).items[0];
  assert.deepEqual([entry.action, entry.previousRestorable, entry.previousSha256], ['removed', true, removed.previousSha256]);
  assert.equal(service.restore(project, { path: 'assets.bin', sha256: removed.previousSha256 }).written, true);
  assert.equal(Buffer.compare(fs.readFileSync(file('assets.bin')), large), 0, 'restored exactly');
  // The same holds inside a directory that is deleted as a whole.
  fs.mkdirSync(file('media')); fs.renameSync(file('assets.bin'), file('media/assets.bin')); fs.writeFileSync(file('media/note.txt'), 'small');
  const directory = service.remove(project, { path: 'media', recursive: true });
  assert.deepEqual([directory.files, directory.restorableFiles, directory.restorable], [2, 2, true]);
  // Beyond what is kept for undo nothing is deleted quietly.
  const huge = fs.openSync(file('dataset.raw'), 'w');
  fs.ftruncateSync(huge, 257 * 1024 * 1024); fs.closeSync(huge);
  assert.throws(() => service.remove(project, { path: 'dataset.raw' }), error => error.code === 'too_large_to_keep' && /257 MiB/.test(error.message) && /force:true/.test(error.message));
  assert.equal(fs.existsSync(file('dataset.raw')), true);
  const forced = service.remove(project, { path: 'dataset.raw', force: true });
  assert.deepEqual([forced.removed, forced.restorable], [true, false]);
  assert.equal(fs.readdirSync(path.join(project.controlRoot, 'history')).some(name => name.startsWith('incoming.')), false, 'no partial copy is left behind');
});
