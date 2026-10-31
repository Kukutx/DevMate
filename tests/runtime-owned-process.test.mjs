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

test('a connector that is still the one written down, and what it was started for, can be taken back instead of ended', async t => {
  const file = path.join(temp(t), 'quick-tunnel.json');
  const kept = await connector(t);
  assert.equal(await ownedProcess(file).remember(kept.pid, { kind: 'cloudflare-quick', forwardsTo: 8789 }), true);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([record.kind, record.forwardsTo, record.pid], ['cloudflare-quick', 8789, kept.pid]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Taken back where it runs as written down and is what the runtime would start; left alone (not ended) otherwise.
  assert.equal((await ownedProcess(file).adopt(about => about.forwardsTo === 8789))?.pid, kept.pid);
  assert.equal(await ownedProcess(file).adopt(about => about.forwardsTo === 9790), null);
  assert.equal(processTree.pidRunning(kept.pid), true, 'a record that does not fit ends nothing by itself');
  // A write that comes when the process is no longer the caller's to write down (it stopped meanwhile, or another
  // runtime wrote down its own) writes nothing.
  const other = path.join(path.dirname(file), 'other.json');
  assert.equal(await ownedProcess(other).remember(kept.pid, { kind: 'cloudflare-quick' }, () => false), false);
  assert.equal(fs.existsSync(other), false);
  // What is learned later is added at once, to the record of that process only.
  assert.equal(ownedProcess(file).amend(kept.pid, { since: '2026-10-31T00:00:00.000Z' }), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).since, '2026-10-31T00:00:00.000Z');
  assert.equal(ownedProcess(file).amend(kept.pid + 1, { since: 'x' }), false);
  assert.equal(ownedProcess(other).amend(kept.pid, { since: 'x' }), false, 'nothing where nothing is written down');
  // A record whose process is another one now is no connector to take back.
  fs.writeFileSync(file, JSON.stringify({ ...record, identity: 'somebody else|0' }));
  assert.equal(await ownedProcess(file).adopt(), null);
  fs.rmSync(file); assert.equal(await ownedProcess(file).adopt(), null);
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
  // Where the system cannot say who the process is (asking took too long on a busy computer), nothing is ended and the
  // record stays: forgotten, a connector still running could never be found again.
  const unknown = { identify: async () => { throw Object.assign(new Error('not known'), { code: 'identity_unknown' }); } };
  fs.writeFileSync(file, JSON.stringify({ pid: stranger.pid, identity: 'x|1' }));
  await assert.rejects(ownedProcess(file, unknown).reap(), { code: 'identity_unknown' });
  await assert.rejects(ownedProcess(file, unknown).adopt(), { code: 'identity_unknown' });
  assert.equal(fs.existsSync(file), true); assert.equal(processTree.pidRunning(stranger.pid), true);
  // So too where the system said who it is, and then, asked again just before it is ended, could not.
  let asked = 0;
  const once = { identify: async () => { if (asked++ === 0) return 'x|1'; throw Object.assign(new Error('not known'), { code: 'identity_unknown' }); } };
  await assert.rejects(ownedProcess(file, once).reap(), { code: 'identity_unknown' });
  assert.equal(fs.existsSync(file), true); assert.equal(processTree.pidRunning(stranger.pid), true);
  // Forgetting a process forgets only its own record: the next runtime may have written down another one meanwhile.
  ownedProcess(file).forget(stranger.pid + 1); assert.equal(fs.existsSync(file), true);
  ownedProcess(file).forget(stranger.pid); assert.equal(fs.existsSync(file), false);
  // A process that already exited is not written down at all.
  const gone = await connector(t), exited = new Promise(resolve => gone.once('exit', resolve));
  gone.kill('SIGKILL'); await exited;
  assert.equal(await ownedProcess(file).remember(gone.pid), false); assert.equal(fs.existsSync(file), false);
});
