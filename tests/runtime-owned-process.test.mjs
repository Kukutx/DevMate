import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ownedProcess, processIdentity } from '../runtime/platform/owned-process.mjs';
import processTree from '../runtime/platform/process-tree.js';

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-owned-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}
// A stand-in for a connector: a real process that keeps running until it is ended.
function connector(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  return new Promise((resolve, reject) => { child.once('spawn', () => resolve(child)); child.once('error', reject); });
}

test('a process is identified by its program and its start, so a reused process id is somebody else', async t => {
  // Start times have a resolution of up to a second (macOS), so the two are started further apart than that.
  const first = await connector(t);
  await new Promise(resolve => setTimeout(resolve, 1100));
  const second = await connector(t);
  const [a, b] = [await processIdentity(first.pid), await processIdentity(second.pid)];
  assert.match(a, /node/i); assert.notEqual(a, b, 'two processes of the same program are still two identities');
  assert.equal(await processIdentity(first.pid), a, 'the identity of a running process does not change');
  assert.equal(await processIdentity(0), null); assert.equal(await processIdentity('x'), null);
  const exited = new Promise(resolve => first.once('exit', resolve));
  first.kill('SIGKILL'); await exited;
  assert.equal(await processIdentity(first.pid), null);
});

test('a connector left behind by a runtime that died is ended by its successor, exactly that one', async t => {
  const file = path.join(temp(t), 'connector.json');
  const orphan = await connector(t), bystander = await connector(t);
  // The earlier runtime wrote its connector down and then died without stopping it.
  assert.equal(await ownedProcess(file).remember(orphan.pid), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, orphan.pid);
  const exited = new Promise(resolve => orphan.once('exit', resolve));
  assert.deepEqual(await ownedProcess(file).reap(), { reaped: true, pid: orphan.pid });
  await exited;
  assert.equal(fs.existsSync(file), false);
  assert.equal(processTree.pidRunning(bystander.pid), true, 'nothing else was touched');
  assert.deepEqual(await ownedProcess(file).reap(), { reaped: false }, 'with no record there is nothing to do');
});

test('a record whose process id now belongs to something else ends nothing', async t => {
  const file = path.join(temp(t), 'connector.json');
  const stranger = await connector(t);
  // The recorded connector is long gone; its process id was handed to an unrelated process.
  fs.writeFileSync(file, JSON.stringify({ pid: stranger.pid, identity: 'C:\\somewhere\\cloudflared.exe|1' }));
  assert.deepEqual(await ownedProcess(file).reap(), { reaped: false, pid: stranger.pid });
  assert.equal(processTree.pidRunning(stranger.pid), true);
  assert.equal(fs.existsSync(file), false, 'the stale record is cleared');
  // Garbage in the record is cleared the same way.
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(await ownedProcess(file).reap(), { reaped: false });
  assert.equal(fs.existsSync(file), false);
  // A process that already exited is not written down at all.
  const gone = await connector(t), exited = new Promise(resolve => gone.once('exit', resolve));
  gone.kill('SIGKILL'); await exited;
  assert.equal(await ownedProcess(file).remember(gone.pid), false); assert.equal(fs.existsSync(file), false);
});
