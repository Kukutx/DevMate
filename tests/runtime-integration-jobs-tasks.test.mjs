import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until } from './runtime-integration-fixtures.mjs';
import { probeInstanceLock } from '../runtime/instance-lock.mjs';

function nativeFixture() {
  const instances = [];
  const factory = options => {
    const instance = {
      calls: [], cancelCalls: 0, cancelResult: { status: 'interrupted' },
      capabilities: { steer: false, approvals: true, mcp: true },
      async start() { return { sessionId: 'fixture-native-' + instances.length, capabilities: instance.capabilities }; },
      async send({ text }) {
        instance.calls.push(text);
        return new Promise(resolve => { instance.finish = value => { instance.finish = null; resolve(value); }; });
      },
      async cancel() {
        instance.cancelCalls++;
        instance.finish?.(instance.cancelResult);
        return { requested: true };
      },
      async close() { instance.finish?.({ status: 'interrupted' }); }
    };
    instances.push(instance); return instance;
  };
  return { instances, factory };
}
async function taskFixture(t) {
  const native = nativeFixture(), f = await fixture(t, { adapterFactory: native.factory });
  const p = await f.project('tasks');
  async function start(workflowId = p.workflow.id) {
    const agent = await f.call('agents.start', { projectId: p.project.id, workflowId, provider: 'codex' });
    await until(() => f.runtime.service.store.get('agent', agent.id).status === 'ready' &&
      !f.runtime.service.agents.sessions.get(agent.id)?.draining, 'agent ready');
    return agent;
  }
  const task = (title, assigneeId) => f.call('task.create', { ...p.scope, title, instruction: title, ...(assigneeId ? { assigneeId } : {}) });
  const read = id => f.call('task.read', { id });
  return { ...f, ...p, native, start, task, read };
}

test('real HTTP command jobs retain results, retry with new execution, and confirm child cancellation', async t => {
  const f = await fixture(t), p = await f.project('commands');
  fs.writeFileSync(path.join(p.root, 'command.mjs'), [
    "import fs from 'node:fs';",
    "const mode=process.argv[2];",
    "if(mode==='retry'){const n=fs.existsSync('attempt.txt')?Number(fs.readFileSync('attempt.txt','utf8'))+1:1;fs.writeFileSync('attempt.txt',String(n));console.log('attempt:'+n);process.exitCode=n===1?7:0;}",
    "else {fs.writeFileSync('child.pid',String(process.pid));console.log('started:'+process.pid);setInterval(()=>{},1000);}"
  ].join('\n'));
  const launch = mode => f.call('job.start', { ...p.scope, kind: 'command', input: { file: process.execPath, args: ['command.mjs', mode] } });
  const read = id => f.call('job.read', { id });
  const failed = await launch('retry');
  const original = await until(async () => { const job = await read(failed.id); return job.status === 'failed' && job; }, 'first attempt');
  assert.equal(original.result.exitCode, 7); assert.equal(original.exitConfirmed, true); assert.match(original.output, /attempt:1/);
  const retry = await f.call('job.retry', { id: original.id });
  assert.notEqual(retry.id, original.id); assert.equal(retry.retryOf, original.id);
  const completed = await until(async () => { const job = await read(retry.id); return job.status === 'completed' && job; }, 'retry result');
  assert.notEqual(completed.executionId, original.executionId); assert.equal(completed.exitConfirmed, true);
  assert.match(completed.output, /attempt:2/); assert.equal((await read(original.id)).status, 'failed');
  const waiting = await launch('wait');
  const pid = await until(() => fs.existsSync(path.join(p.root, 'child.pid')) && Number(fs.readFileSync(path.join(p.root, 'child.pid'), 'utf8')), 'child entered');
  const cancelled = await f.call('job.cancel', { id: waiting.id });
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.exitConfirmed, true);
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  // Jobs are not an everyday model tool; they stay one call away through the generic one.
  const fetched = await f.tool('operations_call', { operation: 'job.read', input: { id: waiting.id } });
  assert.equal(fetched.structuredContent.status, 'cancelled'); assert.match(fetched.structuredContent.output, /started:/);
});

test('runtime.stop through local HTTP drains a real command before releasing ownership', async t => {
  const f = await fixture(t), p = await f.project('shutdown');
  fs.writeFileSync(path.join(p.root, 'wait.mjs'), "import fs from 'node:fs';fs.writeFileSync('owned.pid',String(process.pid));setInterval(()=>{},1000);");
  await f.call('job.start', { ...p.scope, kind: 'command', input: { file: process.execPath, args: ['wait.mjs'] } });
  const pid = await until(() => fs.existsSync(path.join(p.root, 'owned.pid')) && Number(fs.readFileSync(path.join(p.root, 'owned.pid'), 'utf8')), 'owned command');
  assert.deepEqual(await f.call('runtime.stop', { expectedGeneration: f.runtime.health.generation }), { stopping: true });
  await f.runtime.stop();
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  assert.equal(fs.existsSync(path.join(f.instanceRoot, 'runtime.json')), false);
  assert.deepEqual(await probeInstanceLock(f.instanceRoot), { alive: false });
  assert.equal(f.runtime.service.closed, true);
});

test('stale task revision fails before cancellation and an honest native completion wins a cancel race', async t => {
  const f = await taskFixture(t), agent = await f.start(), task = await f.task('race', agent.id);
  await until(() => f.native.instances[0].finish, 'native entered');
  const running = await f.read(task.id);
  assert.equal(running.status, 'running'); assert.notEqual(running.revision, task.revision);
  const stale = await f.local('task.update', { id: task.id, expectedRevision: task.revision, status: 'cancelled' });
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict');
  assert.equal(f.native.instances[0].cancelCalls, 0);
  assert.equal((await f.read(task.id)).status, 'running');
  // The native provider completes exactly while handling the cancellation request.
  f.native.instances[0].cancelResult = { status: 'completed', text: 'actual completed result', native: { outcome: 'completed' } };
  await f.call('task.update', { id: task.id, expectedRevision: running.revision, status: 'cancelled' });
  const final = await until(async () => { const item = await f.read(task.id); return item.status === 'completed' && item; }, 'completion race');
  assert.equal(final.result, 'actual completed result'); assert.equal(f.native.instances[0].cancelCalls, 1);
  const job = await f.call('job.read', { id: final.jobId });
  assert.equal(job.status, 'completed'); assert.equal(job.nativeResult.status, 'completed');
});

test('invalid cross-workflow task assignment leaves task, messages and turn budget unchanged', async t => {
  const f = await taskFixture(t);
  const other = await f.call('workflow.create', { projectId: f.project.id, title: 'other' });
  const agent = await f.start(other.id), task = await f.task('pending');
  const before = f.runtime.service.store.get('workflow', f.workflow.id);
  const changed = await f.local('task.update', { id: task.id, expectedRevision: task.revision, assigneeId: agent.id, title: 'should not persist' });
  assert.equal(changed.status, 403); assert.equal(changed.body.error.code, 'scope_mismatch');
  assert.deepEqual(await f.read(task.id), task);
  assert.equal((await f.call('message.list', f.scope)).items.length, 0);
  assert.equal(f.runtime.service.store.get('workflow', f.workflow.id).usedTurns, before.usedTurns);
  assert.deepEqual(f.native.instances[0].calls, []);
});

test('pausing a workflow holds already-queued tasks until explicit resume without losing their order', async t => {
  const f = await taskFixture(t), agent = await f.start();
  const first = await f.task('first', agent.id);
  await until(() => f.native.instances[0].finish, 'first entered');
  const second = await f.task('second', agent.id);
  assert.equal((await f.read(second.id)).status, 'queued');
  await f.call('workflow.update', { id: f.workflow.id, status: 'paused' });
  f.native.instances[0].finish({ status: 'completed', text: 'first result' });
  await until(() => !f.runtime.service.agents.sessions.get(agent.id).draining, 'paused drain settled');
  assert.equal((await f.read(first.id)).status, 'completed');
  assert.equal((await f.read(second.id)).status, 'queued');
  assert.deepEqual(f.native.instances[0].calls, ['first']);
  await f.call('workflow.update', { id: f.workflow.id, status: 'active' });
  await until(() => f.native.instances[0].calls.length === 2 && f.native.instances[0].finish, 'resumed second task');
  f.native.instances[0].finish({ status: 'completed', text: 'second result' });
  await until(async () => (await f.read(second.id)).status === 'completed', 'second completion');
  assert.deepEqual(f.native.instances[0].calls, ['first', 'second']);
});
