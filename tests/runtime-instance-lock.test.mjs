import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { acquireInstanceLock, lockEndpoint, probeInstanceLock } from '../runtime/instance-lock.mjs';

function temp(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return directory;
}
const identity = generation => ({ pid: process.pid, instanceId: 'instance', generation });

test('an instance has one owner at a time and answers who it is', async t => {
  const root = temp(t);
  assert.deepEqual(await probeInstanceLock(root), { alive: false });
  const lock = await acquireInstanceLock(root, identity('first'));
  assert.deepEqual(await probeInstanceLock(root), { alive: true, responsive: true, pid: process.pid, generation: 'first', instanceId: 'instance' });
  await assert.rejects(acquireInstanceLock(root, identity('second')), error => error.code === 'instance_running' && error.owner.generation === 'first');
  assert.equal((await probeInstanceLock(root)).generation, 'first', 'the loser did not disturb the owner');
  await lock.close();
  assert.deepEqual(await probeInstanceLock(root), { alive: false });
  const next = await acquireInstanceLock(root, identity('third'));
  assert.equal((await probeInstanceLock(root)).generation, 'third');
  await next.close();
});

test('a directory that does not exist has no owner and probing creates nothing', async t => {
  const root = path.join(temp(t), 'never created');
  assert.deepEqual(await probeInstanceLock(root), { alive: false });
  assert.equal(fs.existsSync(root), false);
});

test('ten simultaneous claims produce exactly one owner', async t => {
  const root = temp(t);
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => acquireInstanceLock(root, identity('claim-' + index))));
  const owners = outcomes.filter(outcome => outcome.status === 'fulfilled');
  assert.equal(owners.length, 1);
  for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'instance_running');
  await owners[0].value.close();
});

test('the same directory is one instance however its path is spelled', { skip: process.platform !== 'win32' && 'junction spelling is a Windows concern' }, async t => {
  const base = temp(t), real = path.join(base, 'instance'), alias = path.join(base, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias, 'junction');
  assert.equal(lockEndpoint(alias), lockEndpoint(real));
  assert.equal(lockEndpoint(real.toUpperCase()), lockEndpoint(real));
  const lock = await acquireInstanceLock(real, identity('real'));
  await assert.rejects(acquireInstanceLock(alias, identity('alias')), { code: 'instance_running' });
  await lock.close();
});

test('the operating system releases the instance the moment its owner dies', async t => {
  const root = temp(t);
  const program = `import { acquireInstanceLock } from ${JSON.stringify(pathToFileURL(path.resolve('runtime/instance-lock.mjs')).href)};
    await acquireInstanceLock(process.argv[2], { pid: process.pid, instanceId: 'child', generation: 'child' });
    process.stdout.write('held\\n'); setInterval(() => {}, 1000);`;
  const file = path.join(root, 'holder.mjs'); fs.writeFileSync(file, program);
  const child = spawn(process.execPath, [file, root], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', code => reject(new Error('holder exited ' + code))); });
  const held = await probeInstanceLock(root);
  assert.deepEqual([held.alive, held.pid, held.generation], [true, child.pid, 'child']);
  // No clean shutdown: the process is killed outright, as in a crash.
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGKILL'); await exited;
  const deadline = Date.now() + 5000;
  let after = await probeInstanceLock(root);
  while (after.alive && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); after = await probeInstanceLock(root); }
  assert.deepEqual(after, { alive: false });
  const successor = await acquireInstanceLock(root, identity('successor'));
  await successor.close();
});
