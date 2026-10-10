import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { createJobRunner } from '../runtime/jobs.mjs';
import { createProcessManager } from '../runtime/processes.mjs';
import { executeCommand } from '../runtime/platform/command-process.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'condition', timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(10); }
}
function fixture(t, executor) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-jobs-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const store = new Store(path.join(temp, 'instance'));
  const project = store.create('project', { root, name: 'Fixture', access: 'write', status: 'ready' });
  const processes = createProcessManager({ instanceRoot: path.join(temp, 'instance'), store });
  const runner = createJobRunner({ store, execute: executor || ((job, { signal }) => processes.complete(store.get('project', job.projectId), job.input, { signal })) });
  t.after(async () => { await runner.close().catch(() => {}); await processes.close().catch(() => {}); store.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const wait = id => until(() => ['completed', 'failed', 'cancelled', 'unknown'].includes(store.get('job', id).status), 'job terminal');
  return { temp, root, store, project, processes, runner, wait };
}
test('real command returns queued immediately then stores output, exit and native result', async t => {
  const f = fixture(t);
  const job = f.runner.start({ projectId: f.project.id, kind: 'command', input: { file: process.execPath, args: ['-e', "process.stdout.write('job output')"] } });
  assert.equal(job.status, 'queued'); assert.equal(job.startedAt, null);
  await f.wait(job.id);
  const completed = f.store.get('job', job.id);
  assert.equal(completed.status, 'completed'); assert.equal(completed.result.exitCode, 0);
  assert.equal(completed.output, 'job output'); assert.equal(completed.input.file, process.execPath);
});
test('nonzero exit is failed and only explicit retry creates a new job', async t => {
  const f = fixture(t);
  const first = f.runner.start({ projectId: f.project.id, kind: 'command', input: { file: process.execPath, args: ['-e', "process.stderr.write('failed');process.exit(7)"] } });
  await f.wait(first.id); assert.equal(f.store.get('job', first.id).status, 'failed');
  assert.equal(f.store.list('job').length, 1);
  const next = f.runner.retry(first.id); assert.notEqual(next.id, first.id); assert.equal(next.retryOf, first.id);
  await f.wait(next.id); assert.equal(f.store.get('job', next.id).result.exitCode, 7);
  assert.equal(f.store.get('job', first.id).status, 'failed');
});
test('queued cancellation never invokes the executor', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return { exitCode: 0 }; });
  const job = f.runner.start({ projectId: f.project.id, kind: 'capability', input: { name: 'inspect' } });
  const cancelled = await f.runner.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.outcome, 'not_started');
  await delay(0); assert.equal(calls, 0);
});
test('real command cancellation waits for owned parent and tool child exit and retains stdout', async t => {
  const f = fixture(t), marker = path.join(f.root, 'pids.json');
  const source = "const fs=require('node:fs');const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.once('spawn',()=>{process.stdout.write('before cancellation');fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));});setInterval(()=>{},1000);";
  const job = f.runner.start({ projectId: f.project.id, kind: 'command', input: { file: process.execPath, args: ['-e', source, marker] } });
  let pids;
  await until(() => {
    try {
      pids = JSON.parse(fs.readFileSync(marker, 'utf8'));
      return Number.isSafeInteger(pids.parent) && Number.isSafeInteger(pids.child) &&
        pids.parent > 0 && pids.child > 0;
    } catch { return false; }
  }, 'complete child PID marker persisted');
  t.after(() => { for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch {} } });
  const cancelled = await f.runner.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.exitConfirmed, true);
  assert.match(cancelled.output, /before cancellation/);
  assert.equal(cancelled.result.exitConfirmed, true);
  for (const pid of Object.values(pids)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('executor cancellation error carries termination evidence and bounded output', async () => {
  const controller = new AbortController();
  // The command says when its output has left it: on a busy machine a fixed wait is sometimes shorter than its start.
  const written = path.join(os.tmpdir(), 'devmate-evidence-' + process.pid + '-' + Date.now());
  const running = executeCommand(process.execPath, ['-e', "process.stdout.write('evidence',()=>require('fs').writeFileSync(process.argv[1],'1'));setInterval(()=>{},1000)", written], { signal: controller.signal, timeoutMs: 20000, maxOutputChars: 1000 });
  running.catch(() => {});
  try { await until(() => fs.existsSync(written)); await delay(50); }
  finally { controller.abort(Object.assign(new Error('requested'), { code: 'fixture_cancel' })); fs.rmSync(written, { force: true }); }
  await assert.rejects(running, error => {
    assert.equal(error.code, 'fixture_cancel'); assert.equal(error.termination.exitConfirmed, true);
    assert.equal(error.result.exitConfirmed, true); assert.match(error.result.stdout, /evidence/); return true;
  });
});
test('unconfirmed cancellation remains unknown and cannot claim project shutdown', async t => {
  let started = false, finish;
  const f = fixture(t, (_job, { signal }) => { started = true; return new Promise(resolve => { finish = () => resolve({ exitConfirmed: false, stdout: 'partial' }); signal.addEventListener('abort', () => {}, { once: true }); }); });
  const job = f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} });
  await until(() => started);
  let resolved = false;
  const cancelling = f.runner.cancel(job.id).then(value => { resolved = true; return value; });
  await delay(20); assert.equal(resolved, false); assert.equal(f.store.get('job', job.id).status, 'cancelling');
  finish(); const result = await cancelling;
  assert.equal(result.status, 'unknown'); assert.equal(result.exitConfirmed, false); assert.equal(result.output, 'partial');
  await assert.rejects(f.runner.closeProject(f.project.id), { code: 'shutdown_unconfirmed' });
  assert.throws(() => f.runner.start({ projectId: f.project.id, kind: 'command', input: {} }), { code: 'project_closed' });
});
test('project closure cancels and awaits its executor without cancelling another project', async t => {
  const controls = new Map();
  const f = fixture(t, (job, { signal }) => new Promise(resolve => {
    controls.set(job.projectId, resolve);
    signal.addEventListener('abort', () => resolve({ exitConfirmed: true, terminated: true }), { once: true });
  }));
  const otherRoot = path.join(f.temp, 'other'); fs.mkdirSync(otherRoot);
  const other = f.store.create('project', { root: otherRoot, access: 'write', status: 'ready', name: 'Other' });
  const a = f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} });
  const b = f.runner.start({ projectId: other.id, kind: 'capability', input: {} });
  await until(() => controls.size === 2);
  const closed = await f.runner.closeProject(f.project.id);
  assert.equal(closed.exitConfirmed, true); assert.equal(f.store.get('job', a.id).status, 'cancelled');
  assert.equal(f.store.get('job', b.id).status, 'running');
  controls.get(other.id)({ exitCode: 0, exitConfirmed: true }); await f.wait(b.id);
  assert.equal(f.store.get('job', b.id).status, 'completed');
});
test('restart queued/running/cancelling becomes unknown and agent-turn remains separately owned', async t => {
  const f = fixture(t, async () => { throw new Error('not expected'); });
  const seeded = ['queued', 'running', 'cancelling'].map(status => f.store.create('job', { projectId: f.project.id, kind: 'command', status, input: { file: process.execPath, args: ['-e', 'process.exit(0)'] } }));
  const agentJob = f.store.create('job', { projectId: f.project.id, kind: 'agent-turn', status: 'running' });
  let calls = 0;
  const restarted = createJobRunner({ store: f.store, execute: async () => { calls++; return { exitCode: 0 }; } });
  await delay(10);
  assert.equal(calls, 0);
  for (const job of seeded) assert.equal(f.store.get('job', job.id).status, 'unknown');
  assert.equal(f.store.get('job', agentJob.id).status, 'running');
  await assert.rejects(restarted.cancel(agentJob.id), { code: 'unsupported_job_kind' });
  await restarted.close();
});
test('failed transaction never dispatches an external effect', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; return {}; });
  assert.throws(() => f.store.transaction(() => { f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} }); throw new Error('rollback'); }), /rollback/);
  await delay(10); assert.equal(calls, 0); assert.equal(f.store.list('job').length, 0);
});
test('results and output are bounded with explicit truncation metadata', async t => {
  const f = fixture(t, async () => ({ payload: 'x'.repeat(1100000), stdout: 'y'.repeat(100000), exitCode: 0 }));
  const job = f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} });
  await f.wait(job.id); const result = f.store.get('job', job.id);
  assert.equal(result.resultTruncated, true); assert.equal(result.result.format, 'json-prefix');
  assert.equal(result.outputTruncated, true); assert.equal(result.output.length, 64000);
});
test('workflow mismatch and read-only project reject before job creation', async t => {
  const f = fixture(t, async () => ({}));
  const otherRoot = path.join(f.temp, 'another-project'); fs.mkdirSync(otherRoot);
  const other = f.store.create('project', { root: otherRoot, access: 'read' });
  const workflow = f.store.create('workflow', { projectId: other.id, status: 'active' });
  assert.throws(() => f.runner.start({ projectId: f.project.id, workflowId: workflow.id, kind: 'capability', input: {} }), { code: 'scope_mismatch' });
  assert.throws(() => f.runner.start({ projectId: other.id, kind: 'command', input: {} }), { code: 'read_only' });
  assert.equal(f.store.list('job').length, 0);
});

test('unknown executor keeps project ownership, retries cleanup, and allows reopen only after confirmation', async t => {
  let cleanups = 0, calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return { exitConfirmed: false, stdout: 'partial', retryTermination: async () => ({ exitConfirmed: ++cleanups >= 2 }) };
  });
  const job = f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} });
  await f.wait(job.id);
  const waiting = f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} });
  await delay(20); assert.equal(calls, 1); assert.equal(f.store.get('job', waiting.id).status, 'queued');
  assert.throws(() => f.runner.retry(job.id), { code: 'execution_unconfirmed' });
  await assert.rejects(f.runner.closeProject(f.project.id), { code: 'shutdown_unconfirmed' });
  assert.throws(() => f.runner.reopenProject(f.project.id), { code: 'execution_unconfirmed' });
  assert.equal(f.store.get('job', waiting.id).status, 'cancelled');
  assert.equal((await f.runner.closeProject(f.project.id)).exitConfirmed, true);
  assert.equal(cleanups, 2);
  assert.equal(f.store.get('job', job.id).status, 'unknown'); // cleanup cannot invent the earlier result
  assert.equal(f.store.get('job', job.id).exitConfirmed, true);
  f.runner.reopenProject(f.project.id);
  const retry = f.runner.retry(job.id);
  assert.equal(retry.retryOf, job.id); assert.notEqual(retry.id, job.id);
  await f.wait(retry.id);
  await f.runner.closeProject(f.project.id);
});
test('runner close failure keeps ownership and a later close retries actual cleanup', async t => {
  let attempts = 0;
  const f = fixture(t, async () => ({ exitConfirmed: false, retryTermination: async () => ({ exitConfirmed: ++attempts >= 2 }) }));
  const job = f.runner.start({ projectId: f.project.id, kind: 'command', input: {} });
  await f.wait(job.id);
  await assert.rejects(f.runner.close(), AggregateError);
  await f.runner.close();
  assert.equal(attempts, 2); assert.equal(f.store.get('job', job.id).exitConfirmed, true);
});
test('pre-launch path validation is failed with no effects and does not retain an executor', async t => {
  const f = fixture(t);
  const job = f.runner.start({ projectId: f.project.id, kind: 'command', input: { file: process.execPath, args: [], cwd: '../' } });
  await f.wait(job.id);
  const result = f.store.get('job', job.id);
  assert.equal(result.status, 'failed'); assert.equal(result.outcome, 'not_started'); assert.equal(result.exitConfirmed, true);
  assert.equal((await f.runner.closeProject(f.project.id)).exitConfirmed, true);
});

test('permission downgrade closes resources then reopens policy-authorized read capabilities', async t => {
  const f = fixture(t, async () => ({ result: 'read capability', exitConfirmed: true }));
  await f.runner.closeProject(f.project.id);
  f.store.update('project', f.project.id, { access: 'read' });
  f.runner.reopenProject(f.project.id);
  assert.throws(() => f.runner.start({ projectId: f.project.id, kind: 'command', input: {} }), { code: 'read_only' });
  const job = f.runner.start({ projectId: f.project.id, kind: 'capability', input: { operation: 'host-authorized-read' } });
  await f.wait(job.id); assert.equal(f.store.get('job', job.id).status, 'completed');
});

test('remote outcome stays unknown after confirmed local settlement but does not block close or explicit retry', async t => {
  let calls = 0;
  const f = fixture(t, async () => { calls++; throw Object.assign(new Error('Remote connection lost'), { code: 'connection_lost', executionSettled: true }); });
  const job = f.runner.start({ projectId: f.project.id, kind: 'capability', input: {} });
  await f.wait(job.id);
  assert.equal(f.store.get('job', job.id).status, 'unknown');
  assert.equal(f.store.get('job', job.id).executionSettled, true);
  await delay(10); assert.equal(calls, 1);
  const retry = f.runner.retry(job.id); assert.equal(retry.retryOf, job.id);
  await f.wait(retry.id); assert.equal(calls, 2);
  assert.equal((await f.runner.closeProject(f.project.id)).exitConfirmed, true);
});
test('local settlement metadata cannot replace owned command termination evidence', async t => {
  const f = fixture(t, async () => { throw Object.assign(new Error('Command cleanup unresolved'), { executionSettled: true }); });
  const job = f.runner.start({ projectId: f.project.id, kind: 'command', input: {} });
  await f.wait(job.id);
  assert.equal(f.store.get('job', job.id).status, 'unknown');
  assert.equal(f.store.get('job', job.id).executionSettled, false);
  assert.throws(() => f.runner.retry(job.id), { code: 'execution_unconfirmed' });
  await assert.rejects(f.runner.closeProject(f.project.id), { code: 'shutdown_unconfirmed' });
});


test('dispatch to another project does not materialize thousands of unrelated queued jobs', async t => {
  const controls=new Map(),executed=[];
  const f=fixture(t,(job)=>new Promise(resolve=>{
    executed.push(job.id);
    controls.set(job.id,resolve);
  }));
  const secondRoot=path.join(f.temp,'second-project');fs.mkdirSync(secondRoot);
  const other=f.store.create('project',{root:secondRoot,name:'Other',access:'write',status:'ready'});
  const blocking=f.runner.start({projectId:f.project.id,kind:'capability',input:{mode:'block'}});
  await until(()=>controls.has(blocking.id),'primary busy');
  const queued=f.store.db.prepare('INSERT INTO entities(id,kind,project_id,workflow_id,revision,data) VALUES(?,?,?,?,?,?)');
  f.store.transaction(()=>{
    for(let i=0;i<1400;i++){
      const id='job-fixture-'+String(i).padStart(6,'0');
      queued.run(id,'job',f.project.id,null,1,JSON.stringify({
        id,projectId:f.project.id,kind:'command',status:'queued',queuedSequence:i+1000
      }));
    }
  });
  const original=f.store.list.bind(f.store);
  let readRows=0;
  f.store.list=(kind,options)=>{
    const rows=original(kind,options);
    if(kind==='job'&&options?.status==='queued')readRows+=rows.length;
    return rows;
  };
  const otherJob=f.runner.start({projectId:other.id,kind:'capability',input:{mode:'other'}});
  try {
    await until(()=>controls.has(otherJob.id),'unblocked project dispatch');
    assert.ok(readRows<=20,'A separate project must dispatch without deserializing unrelated queued jobs: '+readRows);
  } finally {
    controls.get(otherJob.id)?.({exitCode:0,exitConfirmed:true});
    f.store.db.exec("UPDATE entities SET data=json_set(data,'$.status','cancelled') WHERE kind='job' AND project_id='"+f.project.id+"' AND id LIKE 'job-fixture-%'");
    controls.get(blocking.id)({exitCode:0,exitConfirmed:true});
    await f.wait(blocking.id);
    if(controls.has(otherJob.id))await f.wait(otherJob.id);
  }
  assert.deepEqual(executed,[blocking.id,otherJob.id]);
});


test('idle startup and shutdown do not deserialize years of completed job history', async t => {
  const f=fixture(t,async()=>({exitCode:0,exitConfirmed:true}));
  const stmt=f.store.db.prepare('INSERT INTO entities(id,kind,project_id,workflow_id,revision,data) VALUES(?,?,?,?,?,?)');
  f.store.transaction(()=>{
    for(let i=0;i<1800;i++){
      const id='job-completed-history-'+String(i).padStart(6,'0');
      stmt.run(id,'job',f.project.id,null,1,JSON.stringify({
        id,projectId:f.project.id,kind:'command',status:'completed',finishedAt:'2020-01-01T00:00:00.000Z'
      }));
    }
  });
  const real=f.store.list.bind(f.store);
  let loaded=0;
  f.store.list=(kind,options={})=>{
    const items=real(kind,options);
    if(kind==='job') loaded+=items.length;
    return items;
  };
  const reopened=createJobRunner({store:f.store,execute:async()=>{throw Error('must never execute historical job');}});
  try {
    await reopened.close();
    assert.ok(loaded<=20,'Idle lifetime must not deserialize '+loaded+' already completed jobs');
  } finally {
    await reopened.close();
    f.store.list=real;
  }
});

