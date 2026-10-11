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
