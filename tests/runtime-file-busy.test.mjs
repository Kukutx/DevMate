import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DevMateService } from '../runtime/service.mjs';
import { DomainError } from '../runtime/store.mjs';

const owner = Object.freeze({ id: 'owner', surface: 'local' });
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-file-busy-')), root = path.join(temp, 'project');
  fs.mkdirSync(root);
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: 'http://127.0.0.1:1/api/agent' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const project = await service.call('project.create', { root, name: 'Busy' }, owner);
  const call = (operation, input) => service.call(operation, { projectId: project.id, ...input }, owner);
  return { service, call, root, file: name => path.join(root, name), read: name => fs.readFileSync(path.join(root, name), 'utf8') };
}

test('a change to a file another program holds is made again until it is let go, and other calls are answered meanwhile', async t => {
  const { service, call, read } = await fixture(t);
  await call('workspace.write', { path: 'a.txt', text: 'one\n' });
  // The file is refused three times, as Windows refuses one a scanner holds, and then let go.
  const real = service.workspace.write;
  let refusals = 3, tries = 0;
  service.workspace.write = (...given) => { tries++; if (refusals-- > 0) throw new DomainError('file_busy', 'held'); return real(...given); };
  const started = Date.now(), writing = call('workspace.write', { path: 'a.txt', text: 'two\n', overwrite: true });
  // While that waits, the runtime answers: the file is read as it still is.
  assert.equal((await call('workspace.read', { path: 'a.txt' })).text, 'one\n');
  assert.equal((await writing).written, true);
  assert.equal(tries, 4); assert.ok(Date.now() - started >= 600, 'it waited between the tries: ' + (Date.now() - started) + ' ms');
  assert.equal(read('a.txt'), 'two\n');
  // Held for longer than it is waited for: said as what it is, and nothing is changed.
  service.fileBusyPatienceMs = 350; refusals = Infinity; tries = 0;
  await assert.rejects(call('workspace.write', { path: 'a.txt', text: 'three\n', overwrite: true }), { code: 'file_busy' });
  assert.equal(tries, 3, 'tried again after 100 and 200 ms, and not once more'); assert.equal(read('a.txt'), 'two\n');
  // A patch of which something is still there no longer fits and is not made again; another refusal is not waited for.
  service.fileBusyPatienceMs = 20000;
  for (const [failure, code] of [[Object.assign(new DomainError('file_busy', 'held'), { incomplete: true }), 'file_busy'], [new DomainError('conflict', 'changed'), 'conflict']]) {
    tries = 0; service.workspace.write = () => { tries++; throw failure; };
    await assert.rejects(call('workspace.write', { path: 'a.txt', text: 'four\n', overwrite: true }), { code });
    assert.equal(tries, 1);
  }
});

test('on Windows a file that is open in a program that lets it be moved is replaced at once, with nothing waited for', { skip: process.platform !== 'win32' && 'only Windows refuses to replace a file another program has open', timeout: 60000 }, async t => {
  const { call, root, file, read } = await fixture(t);
  await call('workspace.write', { path: 'open.txt', text: 'before\n' });
  // The way a scanner, an editor or a watching server has a file open: others may read, write, move and delete it.
  // Windows still replaces no file that is open, which is what a write over an existing file would do.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:DEVMATE_HELD,'Open','Read','ReadWrite, Delete');[Console]::Out.WriteLine('held');Start-Sleep -Seconds 20;$f.Close()"],
  { env: { ...process.env, DEVMATE_HELD: file('open.txt') }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
  const started = Date.now();
  assert.equal((await call('workspace.write', { path: 'open.txt', text: 'after\n', overwrite: true })).written, true);
  assert.equal((await call('workspace.edit', { path: 'open.txt', edits: [{ oldText: 'after', newText: 'edited' }] })).replacements, 1);
  assert.ok(Date.now() - started < 3000, 'nothing was waited for: ' + (Date.now() - started) + ' ms');
  assert.equal(read('open.txt'), 'edited\n'); assert.equal(child.exitCode, null, 'the other program still has the old file open');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.devmate-write-')), [], 'what was moved aside is gone');
  // And it is in the history like any other change.
  const history = (await call('workspace.history', { path: 'open.txt' })).items;
  assert.deepEqual(history.map(item => item.action), ['written', 'written', 'written']);
});

test('on Windows a file marked read-only is left as it is by every change, and says so', { skip: process.platform !== 'win32' && 'the mark means this on Windows', timeout: 60000 }, async t => {
  const { call, root, file, read } = await fixture(t);
  await call('workspace.write', { path: 'fixed.txt', text: 'as it is\n' });
  await call('workspace.write', { path: 'other.txt', text: 'other\n' });
  fs.chmodSync(file('fixed.txt'), 0o444);
  t.after(() => { try { fs.chmodSync(file('fixed.txt'), 0o666); } catch { /* gone */ } });
  // Windows replaces no read-only file by one renamed over it. Moved aside it could be, and it is not.
  for (const [operation, input] of [['workspace.write', { path: 'fixed.txt', text: 'new\n', overwrite: true }], ['workspace.edit', { path: 'fixed.txt', edits: [{ oldText: 'as it is', newText: 'changed' }] }],
    ['workspace.write', { path: 'fixed.txt', text: 'more\n', append: true }], ['workspace.move', { from: 'other.txt', to: 'fixed.txt', overwrite: true }], ['workspace.delete', { path: 'fixed.txt' }]])
    await assert.rejects(call(operation, input), { code: 'read_only_file', message: /^fixed\.txt is marked read-only and was left as it is\. Take the mark off, with a command, to change it\.$/ }, operation + (input.append ? ' append' : ''));
  // A patch says the same, as the reason it was not applied.
  await assert.rejects(call('workspace.patch', { patch: '*** Begin Patch\n*** Update File: fixed.txt\n-as it is\n+patched\n*** End Patch\n' }),
    /^DomainError: The patch was not applied: fixed\.txt is marked read-only and was left as it is\./);
  assert.equal(read('fixed.txt'), 'as it is\n'); assert.equal(read('other.txt'), 'other\n');
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.devmate-write-')), [], 'no working copy is left behind');
  // With the mark off it is a file like any other.
  fs.chmodSync(file('fixed.txt'), 0o666);
  assert.equal((await call('workspace.write', { path: 'fixed.txt', text: 'new\n', overwrite: true })).written, true);
});

test('a folder of which only part could be deleted says how much is gone, and the rest goes with the next call', { skip: process.platform !== 'win32' && 'only Windows keeps a file that is open from being deleted', timeout: 90000 }, async t => {
  const { call, file, read } = await fixture(t);
  for (const name of ['a.txt', 'b.txt', 'z-held.txt']) await call('workspace.write', { path: 'out/' + name, text: name + '\n' });
  // The last file of the folder is open in a program that lets nobody delete it.
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$f=[IO.File]::Open($env:DEVMATE_HELD,'Open','Read','Read');[Console]::Out.WriteLine('held');[Console]::In.ReadLine() | Out-Null;$f.Close()"],
  { env: { ...process.env, DEVMATE_HELD: file('out/z-held.txt') }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { child.kill(); });
  await new Promise((resolve, reject) => { child.once('error', reject); child.stdout.once('data', resolve); });
  const point = (await call('workspace.history', {})).items[0].sequence;
  await assert.rejects(call('workspace.delete', { path: 'out', recursive: true }), error => {
    assert.equal(error.code, 'delete_incomplete');
    assert.equal(error.message, 'Only part of out was deleted: 2 of the 3 file(s) in it are gone and can be brought back (workspace_history lists them). Then this stopped it: another program has a file in it open. The rest is still there; the same call again deletes it once that is out of the way.');
    assert.deepEqual(error.details, { deleted: 2, restorable: 2, remaining: 1 });
    return true;
  });
  assert.equal(fs.existsSync(file('out/a.txt')), false); assert.equal(read('out/z-held.txt'), 'z-held.txt\n');
  // What is gone is in the history, each file under its own path.
  const gone = (await call('workspace.history', {})).items.filter(item => item.sequence > point);
  assert.deepEqual(gone.map(item => item.action + ' ' + item.path).sort(), ['removed out/a.txt', 'removed out/b.txt']);
  // Deleted with force, what is gone is gone for good, and that is said.
  for (const name of ['c.txt', 'd.txt']) await call('workspace.write', { path: 'out/' + name, text: name + '\n' });
  await assert.rejects(call('workspace.delete', { path: 'out', recursive: true, force: true }), { code: 'delete_incomplete', message: /2 of the 3 file\(s\) in it are gone and can be brought back/ });
  // The program lets go: the same call deletes what was left, and counts what it deleted itself.
  child.stdin.write('\n'); await new Promise(resolve => child.once('exit', resolve));
  const rest = await call('workspace.delete', { path: 'out', recursive: true });
  assert.equal(rest.removed, true); assert.equal(rest.files, 1); assert.equal(fs.existsSync(file('out')), false);
});

test('on Windows a file a program really holds is replaced when it lets go, and the runtime is not held up while it waits', { skip: process.platform !== 'win32' && 'only Windows refuses to replace a file another program has open', timeout: 90000 }, async t => {
  const { service, call, root, file, read } = await fixture(t);
  await call('workspace.write', { path: 'held.txt', text: 'before\n' });
  // Another program opens the file as a scanner does: others may read it, nobody may replace, move or delete it.
  const hold = ms => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$f=[IO.File]::Open($env:DEVMATE_HELD,'Open','Read','Read');[Console]::Out.WriteLine('held');Start-Sleep -Milliseconds " + ms + ";$f.Close()"],
    { env: { ...process.env, DEVMATE_HELD: file('held.txt') }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    t.after(() => { child.kill(); });
    child.once('error', reject);
    child.stdout.once('data', () => resolve({ released: new Promise(done => child.once('exit', done)) }));
  });
  const first = await hold(2500);
  let ticks = 0;
  const ticking = setInterval(() => { ticks++; }, 50), started = Date.now();
  const written = await call('workspace.write', { path: 'held.txt', text: 'after\n', overwrite: true });
  clearInterval(ticking);
  assert.equal(written.written, true); assert.equal(read('held.txt'), 'after\n');
  assert.ok(Date.now() - started >= 1500, 'the file was waited for: ' + (Date.now() - started) + ' ms');
  assert.ok(ticks >= 15, 'the runtime went on while it waited: ' + ticks + ' turns of 50 ms');
  await first.released;
  // Held for longer than it is waited for: every change says so, and the file is as it was.
  service.fileBusyPatienceMs = 400;
  const second = await hold(6000);
  for (const [operation, input] of [['workspace.write', { path: 'held.txt', text: 'never\n', overwrite: true }], ['workspace.edit', { path: 'held.txt', edits: [{ oldText: 'after', newText: 'never' }] }],
    ['workspace.delete', { path: 'held.txt' }], ['workspace.move', { from: 'held.txt', to: 'moved.txt' }]])
    await assert.rejects(call(operation, input), { code: 'file_busy', message: /^Windows does not let held\.txt be changed right now: another program has it open/ }, operation);
  assert.equal(read('held.txt'), 'after\n'); assert.equal(fs.existsSync(file('moved.txt')), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.devmate-write-')), [], 'no working copy is left behind');
  second.released.then(() => {});
});
