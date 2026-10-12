import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DevMateService } from '../runtime/service.mjs';
import { DomainError } from '../runtime/store.mjs';
import { __test as workspaceTest } from '../runtime/workspace.mjs';

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
  // Held for longer than it is waited for: said as what it is, and nothing is changed. What refuses for that long is
  // not a scanner's moment: a program that keeps the file open, or permissions, for which Windows answers the same.
  service.fileBusyPatienceMs = 350; refusals = Infinity; tries = 0;
  service.workspace.write = () => { tries++; throw new DomainError('file_busy', 'Windows does not let a.txt be changed right now. It was left as it is. Try again in a moment.'); };
  await assert.rejects(call('workspace.write', { path: 'a.txt', text: 'three\n', overwrite: true }), { code: 'file_busy',
    message: 'Windows does not let a.txt be changed right now. It was left as it is. It stayed so for 1 second(s) of trying again: a program keeps it open, or this account is not allowed to change it (its permissions).' });
  assert.equal(tries, 3, 'tried again after 100 and 200 ms, and not once more'); assert.equal(read('a.txt'), 'two\n');
  // The same where the refusal is not the end of what is said: workspace.patch says after it what became of the rest.
  service.workspace.write = () => { throw new DomainError('file_busy', 'The patch was not applied: Windows does not let a.txt be changed right now. It was left as it is. Try again in a moment. Nothing of it was kept.'); };
  await assert.rejects(call('workspace.write', { path: 'a.txt', text: 'three\n', overwrite: true }), { code: 'file_busy',
    message: 'The patch was not applied: Windows does not let a.txt be changed right now. It was left as it is. Nothing of it was kept. It stayed so for 1 second(s) of trying again: a program keeps it open, or this account is not allowed to change it (its permissions).' });
  // A file that was moved out of the way and could be neither replaced nor put back is said as that, with where what it
  // held lies, and is not made again by itself.
  tries = 0; service.workspace.write = () => { tries++; throw Object.assign(new DomainError('file_displaced', 'no file under that name'), { incomplete: true }); };
  await assert.rejects(call('workspace.write', { path: 'a.txt', text: 'three\n', overwrite: true }), { code: 'file_displaced' }); assert.equal(tries, 1);
  // A patch of which something is still there no longer fits and is not made again; another refusal is not waited for.
  service.fileBusyPatienceMs = 20000;
  for (const [failure, code] of [[Object.assign(new DomainError('file_busy', 'held'), { incomplete: true }), 'file_busy'], [new DomainError('conflict', 'changed'), 'conflict']]) {
    tries = 0; service.workspace.write = () => { tries++; throw failure; };
    await assert.rejects(call('workspace.write', { path: 'a.txt', text: 'four\n', overwrite: true }), { code });
    assert.equal(tries, 1);
  }
});

// The text goes to the end of the file itself, and what the file holds then is read back for its hash. A program
// that writes to the same file can push it past what is read whole in between: the call failed, with the text in the
// file and nothing in the history, and a model added it a second time.
test('text that was added to a file is said as added also where the file cannot be read back', async t => {
  const { call, file } = await fixture(t);
  await call('workspace.write', { path: 'server.log', text: 'started\n' });
  const real = fs.appendFileSync;
  fs.appendFileSync = (target, data, ...rest) => { real(target, data, ...rest); if (path.basename(String(target)) === 'server.log') real(target, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)); };
  let added;
  try { added = await call('workspace.write', { path: 'server.log', text: 'noted\n', append: true }); } finally { fs.appendFileSync = real; }
  assert.deepEqual([added.path, added.written, added.sha256], ['server.log', true, undefined]);
  assert.equal(added.note, 'The text was added. What the file holds now could not be read back, because another program is writing to it: no sha256 is given. Read the file again before changing it.');
  const held = fs.readFileSync(file('server.log'));
  assert.equal(held.subarray(0, 14).toString(), 'started\nnoted\n'); assert.equal(held.length, 14 + 8 * 1024 * 1024 + 1, 'added once');
  // It is in the history as a change, and what it left is not known: taking it back leaves the file alone and says why.
  const entry = (await call('workspace.history', {})).items[0];
  assert.deepEqual([entry.path, entry.sha256 ?? null], ['server.log', null]);
  const taken = await call('workspace.restore', { since: entry.sequence - 1 });
  assert.deepEqual(taken.left.map(item => [item.path, item.reason]), [['server.log', 'what this change wrote was not recorded (it was too large, or another program was writing to the file), so it cannot be told whether it was changed since']]);
});

// What was moved out of the way and could not be removed at once is removed with a later change to any file, and a
// file that is missing after a move is named as the one that is missing.
test('a working copy that was left behind goes with the next change, and a move names the file that is gone', async t => {
  const { call, root, file } = await fixture(t);
  const left = path.join(root, '.devmate-write-left-behind'); fs.writeFileSync(left, 'what a file held');
  workspaceTest.leftAside.add(left);
  await call('workspace.write', { path: 'a.txt', text: 'one\n' });
  assert.equal(fs.existsSync(left), true, 'a new file replaces nothing, and nothing is tried');
  await call('workspace.write', { path: 'a.txt', text: 'two\n', overwrite: true });
  assert.equal(fs.existsSync(left), false); assert.equal(workspaceTest.leftAside.size, 0);
  // Of the two files of a move the one that was to be replaced is the one that is gone; the other is where it was.
  assert.throws(() => workspaceTest.unheld(true, 'from.txt or to.txt', file('from.txt'), () => { throw Object.assign(new Error('refused'), { displaced: path.join(root, '.devmate-write-1') }); }, 'to.txt'),
    { code: 'file_displaced', message: /^to\.txt could not be replaced, and could not be put back where it was: there is no file under that name now\. What it held is in \.devmate-write-1 in the same folder/ });
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
