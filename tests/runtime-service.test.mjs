import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DevMateService } from '../runtime/service.mjs';

const testOwner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const ownerCall = (service, name, input = {}) => service.call(name, input, testOwner);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'condition', timeout = 1800) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out: ' + label); await delay(5); }
}
function controlledFactory() {
  const instances = [];
  const factory = options => {
    const instance = {
      options, calls: [], mode: 'complete', closed: false, capabilities: { steer: false, approvals: true, mcp: true },
      async start() { return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
      async send({ text }) {
        instance.calls.push(text);
        options.onEvent({ type: 'message', text: 'delta:', delta: true, native: { type: 'fixture' } });
        if (instance.mode === 'approval') {
          instance.controller = new AbortController();
          try {
            instance.choice = await options.onApproval({ id: 'native-approval', kind: 'Write', options: [{ optionId: 'allow' }, { optionId: 'deny' }], details: { path: 'a.txt' }, native: { method: 'request' } }, { signal: instance.controller.signal });
          } catch { return { status: 'interrupted' }; }
        }
        if (instance.mode === 'wait') return new Promise(resolve => instance.finish = resolve);
        return { status: 'completed', text: 'reply:' + text, native: { status: 'completed' } };
      },
      async cancel() {
        instance.controller?.abort();
        instance.finish?.({ status: 'interrupted', native: { cancelled: true } });
        return { requested: true };
      },
      async close() { instance.closed = true; instance.controller?.abort(); instance.finish?.({ status: 'interrupted', outcome: 'unconfirmed' }); }
    };
    instances.push(instance); return instance;
  };
  return { factory, instances };
}
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-service-'));
  const projectRoot = path.join(temp, 'project'); fs.mkdirSync(projectRoot);
  const stateRoot = path.join(temp, 'state');
  const native = controlledFactory();
  const service = new DevMateService({ instanceRoot: stateRoot, endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: native.factory });
  t.after(async () => { if (!service.testClosed) await service.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const project = await ownerCall(service,'project.create', { root: projectRoot });
  const workflow = await ownerCall(service,'workflow.create', { projectId: project.id, title: 'Fixture' });
  const scope = { projectId: project.id, workflowId: workflow.id };
  const start = async (provider = 'codex', workflowId = workflow.id) => {
    const agent = await ownerCall(service,'agents.start', { projectId: project.id, workflowId, provider });
    await until(() => service.store.get('agent', agent.id).status === 'ready', 'agent ready');
    await until(() => !service.agents.sessions.get(agent.id)?.draining, 'initial drain');
    return agent;
  };
  return { temp, stateRoot, project, workflow, scope, service, native, start };
}

test('durable messages produce native delivery, job completion and a stored reply', async t => {
  const { service, scope, start, native } = await fixture(t);
  const agent = await start();
  const message = await ownerCall(service,'message.send', { ...scope, recipientIds: [agent.id], body: 'hello' });
  await until(() => service.store.get('message', message.id).status === 'delivered', 'delivery complete');
  assert.deepEqual(native.instances[0].calls, ['hello']);
  const delivery = service.store.list('delivery', scope)[0], job = service.store.get('job', delivery.jobId);
  assert.equal(delivery.status, 'delivered'); assert.equal(job.status, 'completed');
  assert.equal(job.output, 'reply:hello'); assert.equal(job.nativeResult.status, 'completed');
  const reply = service.store.list('message', scope).find(item => item.replyTo === message.id);
  assert.equal(reply.body, 'reply:hello'); assert.equal(reply.sender.id, agent.id);
  assert.ok(service.store.events(scope).some(e => e.type === 'agent.native'));
});

test('bound native channel actually delivers between providers and rejects another workflow', async t => {
  const { service, start, native, project } = await fixture(t);
  const sender = await start('codex'), receiver = await start('gemini');
  const otherWorkflow = await ownerCall(service,'workflow.create', { projectId: project.id, title: 'Other' });
  const other = await start('grok', otherWorkflow.id);
  const token = native.instances[0].options.mcpServers.find(s => s.name === 'devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const peers = service.agents.channelCall(token, 'agent_peers', {});
  assert.deepEqual(new Set(peers.items.map(x => x.id)), new Set([sender.id, receiver.id]));
  assert.throws(() => service.agents.channelCall(token, 'agent_send_message', { operationId:'scope-test', recipientIds: [other.id], body: 'escape' }), { code: 'scope_mismatch' });
  const message = service.agents.channelCall(token, 'agent_send_message', { operationId:'review-message', recipientIds: [receiver.id], body: 'please review' });
  await until(() => service.store.get('message', message.id).status === 'delivered');
  assert.match(native.instances[1].calls[0], /Message from codex/);
  assert.match(native.instances[1].calls[0], /please review/);
  assert.equal(message.sender.id, sender.id);
  assert.ok(service.agents.channelCall(token, 'agent_inbox', {}).items.some(x => x.id === message.id));
});

test('pending approval resolves exact native choice once and late answers fail', async t => {
  const { service, scope, start, native } = await fixture(t);
  const agent = await start(); native.instances[0].mode = 'approval';
  const message = await ownerCall(service,'message.send', { ...scope, recipientIds: [agent.id], body: 'needs approval' });
  await until(() => service.store.list('approval', scope).length === 1);
  const approval = service.store.list('approval', scope)[0];
  await assert.rejects(ownerCall(service,'approval.resolve', { id: approval.id, optionId: 'invented' }), { code: 'invalid_option' });
  await ownerCall(service,'approval.resolve', { id: approval.id, optionId: 'allow', expectedRevision: approval.revision });
  await until(() => service.store.get('message', message.id).status === 'delivered');
  assert.deepEqual(native.instances[0].choice, { optionId: 'allow' });
  await assert.rejects(ownerCall(service,'approval.resolve', { id: approval.id, optionId: 'allow' }), { code: 'request_expired' });
});

test('cancel expires pending approval and never records completion', async t => {
  const { service, scope, start, native } = await fixture(t);
  const agent = await start(); native.instances[0].mode = 'approval';
  const message = await ownerCall(service,'message.send', { ...scope, recipientIds: [agent.id], body: 'cancel approval' });
  await until(() => service.store.list('approval', scope).length === 1);
  const approval = service.store.list('approval', scope)[0];
  await ownerCall(service,'agents.cancel', { id: agent.id });
  await until(() => service.store.get('message', message.id).status === 'cancelled');
  assert.equal(service.store.get('approval', approval.id).status, 'expired');
  assert.equal(service.store.list('job', scope)[0].status, 'cancelled');
  assert.equal(service.store.get('agent', agent.id).status, 'ready');
  await assert.rejects(ownerCall(service,'approval.resolve', { id: approval.id, optionId: 'allow' }), { code: 'request_expired' });
});

test('synchronous cancellation completion cannot leave agent stuck cancelling', async t => {
  const { service, scope, start, native } = await fixture(t);
  const agent = await start(); native.instances[0].mode = 'wait';
  const message = await ownerCall(service,'message.send', { ...scope, recipientIds: [agent.id], body: 'wait' });
  await until(() => !!native.instances[0].finish);
  await ownerCall(service,'agents.cancel', { id: agent.id });
  await until(() => service.store.get('message', message.id).status === 'cancelled');
  await delay(0);
  assert.equal(service.store.get('agent', agent.id).status, 'ready');
});

test('message arriving after drain returns but before its finalizer is delivered', async t => {
  const { service, scope, start, native } = await fixture(t);
  const agent = await start();
  const original = service.agents.drain.bind(service.agents);
  let appended;
  service.agents.drain = async (...args) => {
    await original(...args);
    if (!appended) appended = service.agents.send({ ...scope, recipientIds: [agent.id], body: 'tail message' }, { id: 'owner', kind: 'user', label: 'You' });
  };
  await ownerCall(service,'message.send', { ...scope, recipientIds: [agent.id], body: 'first' });
  await until(() => appended && service.store.get('message', appended.id).status === 'delivered', 'drain tail delivery');
  assert.deepEqual(native.instances[0].calls, ['first', 'tail message']);
});

test('operationId deduplicates concurrent effects and preserves completed results', async t => {
  const { service } = await fixture(t);
  let calls = 0, finish;
  service.register('fixture.once', { operationId: (await import('zod')).z.string() }, false, 'fixture', () => { calls++; return new Promise(resolve => finish = resolve); });
  const first = ownerCall(service,'fixture.once', { operationId: 'same' });
  const second = ownerCall(service,'fixture.once', { operationId: 'same' });
  await until(() => !!finish); finish({ calls });
  assert.deepEqual(await first, { calls: 1 }); assert.deepEqual(await second, { calls: 1 });
  assert.deepEqual(await ownerCall(service,'fixture.once', { operationId: 'same' }), { calls: 1 });
  assert.equal(calls, 1);
  await assert.rejects(ownerCall(service,'workflow.create', { projectId: 'different', title: 'x', operationId: 'same' }), { code: 'operation_conflict' });
});

test('persisted pending operation reports unknown rather than executing again', async t => {
  const { service } = await fixture(t);
  let calls = 0;
  service.register('fixture.pending', { operationId: (await import('zod')).z.string() }, false, 'fixture', () => { calls++; return {}; });
  const args = { operationId: 'pending' };
  const fingerprint = createHash('sha256').update(JSON.stringify({ name: 'fixture.pending', args })).digest('hex');
  service.store.saveOperation('owner:pending', 'fixture.pending', fingerprint, { pending: true });
  await assert.rejects(ownerCall(service,'fixture.pending', args), { code: 'outcome_unknown' });
  assert.equal(calls, 0);
});

test('restart expires approvals and marks interrupted job, delivery, message and task unknown without replay', async t => {
  const f = await fixture(t), { service, scope, stateRoot } = f;
  const agent = service.store.create('agent', { ...scope, provider: 'claude', status: 'running', label: 'fixture', nativeSessionId: 'native-resume' });
  const task = service.store.create('task', { ...scope, title: 'Interrupted', status: 'running' });
  const message = service.store.create('message', { ...scope, sender: { kind: 'user', id: 'owner' }, recipientIds: [agent.id], body: 'side effect', status: 'running', taskId: task.id });
  const delivery = service.store.create('delivery', { ...scope, agentId: agent.id, messageId: message.id, taskId: task.id, status: 'running' });
  const job = service.store.create('job', { ...scope, kind: 'agent-turn', agentId: agent.id, deliveryId: delivery.id, taskId: task.id, status: 'running' });
  const approval = service.store.create('approval', { ...scope, agentId: agent.id, jobId: job.id, status: 'pending', options: [{ optionId: 'allow' }] });
  await service.close(); service.testClosed = true;
  let spawned = 0;
  const reopened = new DevMateService({ instanceRoot: stateRoot, adapterFactory: () => { spawned++; throw new Error('must not run'); } });
  try {
    assert.equal(reopened.store.get('agent', agent.id).status, 'disconnected');
    for (const [kind, id] of [['job', job.id], ['delivery', delivery.id], ['message', message.id], ['task', task.id]]) assert.equal(reopened.store.get(kind, id).status, 'unknown', kind);
    assert.equal(reopened.store.get('approval', approval.id).status, 'expired');
    await assert.rejects(ownerCall(reopened,'approval.resolve', { id: approval.id, optionId: 'allow' }), { code: 'request_expired' });
    await delay(10); assert.equal(spawned, 0);
  } finally { await reopened.close(); }
});


test('service operations refuse unverified identities instead of assuming owner', async t => {
  const { service, project } = await fixture(t);
  await assert.rejects(service.call('project.list', {}), { code: 'unauthorized' });
  await assert.rejects(service.call('project.list', {}, { role: 'owner' }), { code: 'unauthorized' });
  await assert.rejects(service.call('workflow.create', { projectId: project.id, title: 'unsafe' }), { code: 'unauthorized' });
  assert.equal(service.store.list('workflow', { projectId: project.id }).length, 1);
  assert.throws(() => service.visibleOperations(), { code: 'unauthorized' });
});


test('member pagination and search are scoped in SQLite before the result limit', async t => {
  const { service, project, temp, workflow } = await fixture(t);
  const foreignRoot = path.join(temp, 'foreign'); fs.mkdirSync(foreignRoot);
  const foreign = await ownerCall(service, 'project.create', { root: foreignRoot });
  const foreignWorkflow = await ownerCall(service, 'workflow.create', { projectId: foreign.id, title: 'Foreign' });
  for (let i = 0; i < 160; i++) service.store.create('task', { projectId: foreign.id, workflowId: foreignWorkflow.id,
    title: 'Needle other ' + i, status: 'active' });
  const allowed = ['Needle first', 'Needle second', 'Needle third'].map(title =>
    service.store.create('task', { projectId: project.id, workflowId: workflow.id, title, status: 'active' }));
  service.store.create('task', { projectId: project.id, workflowId: workflow.id, title: 'Different', status: 'active' });
  const member = { id: 'member-visibility', role: 'read', projectIds: [project.id] };
  const seen = [], observed = [];
  const list = service.store.list.bind(service.store);
  service.store.list = (kind, options) => {
    if (kind === 'task') observed.push(options);
    return list(kind, options);
  };
  let cursor;
  do {
    const response = await service.call('task.list', { query: 'NEEDLE', limit: 1, ...(cursor ? { cursor } : {}) }, member);
    seen.push(...response.items.map(item => item.id));
    cursor = response.nextCursor;
  } while (cursor);
  assert.deepEqual(new Set(seen), new Set(allowed.map(item => item.id)));
  assert.equal(seen.length, allowed.length);
  assert.ok(observed.every(entry => entry.limit === 2 && entry.query === 'NEEDLE' &&
    entry.projectIds?.length === 1 && entry.projectIds[0] === project.id));
  assert.deepEqual((await service.call('project.list', {}, { ...member, projectIds: [] })).items, []);
  assert.equal(service.store.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='entities_status_scope'").get().n, 1);
});


test('revoking a member cancels their queued command before any side effect', async t => {
  const { service, project } = await fixture(t);
  const executed = [];
  let release;
  service.processes.complete = async (_project, input) => {
    if (input.args?.[0] === 'block') return new Promise(resolve => release = () => resolve({ exitCode: 0, exitConfirmed: true }));
    executed.push(input.args?.[0]); return { exitCode: 0, exitConfirmed: true };
  };
  const blocker = await ownerCall(service, 'job.start', { projectId: project.id, kind: 'command', input: { file: process.execPath, args: ['block'] } });
  await until(() => !!release, 'blocker running');
  const member = await ownerCall(service, 'auth.member.create', { name: 'Queued member', role: 'write', projectIds: [project.id] });
  const principal = { id: member.id, role: 'write', projectIds: [project.id], authVersion: 1 };
  const pending = await service.call('job.start', { projectId: project.id, kind: 'command',
    input: { file: process.execPath, args: ['should-not-run'] } }, principal);
  assert.equal(service.store.get('job', pending.id).status, 'queued');
  await ownerCall(service, 'auth.member.update', { id: member.id, disabled: true, expectedRevision: member.revision });
  assert.equal(service.store.get('job', pending.id).status, 'cancelled');
  assert.equal(service.store.get('job', pending.id).outcome, 'not_started');
  release();await until(() => service.store.get('job', blocker.id).status === 'completed');
  assert.deepEqual(executed, []);
  const retried = await ownerCall(service, 'job.retry', { id: pending.id });
  await until(() => service.store.get('job', retried.id).status === 'completed');
  assert.deepEqual(executed, ['should-not-run']);
  assert.equal(service.store.get('job', retried.id).input.caller.id, 'owner');
});

test('execution preflight rejects jobs whose member changed without a cancellation callback', async t => {
  const { service, project } = await fixture(t);
  const executed = [];
  let release;
  service.processes.complete = async (_project, input) => {
    if (input.args?.[0] === 'block') return new Promise(resolve => release = () => resolve({ exitCode: 0, exitConfirmed: true }));
    executed.push(input.args?.[0]); return { exitCode: 0, exitConfirmed: true };
  };
  const blocker = await ownerCall(service, 'job.start', { projectId: project.id, kind: 'command', input: { file: process.execPath, args: ['block'] } });
  await until(() => !!release, 'blocker running');
  const member = await ownerCall(service, 'auth.member.create', { name: 'Preflight member', role: 'write', projectIds: [project.id] });
  const pending = await service.call('job.start', { projectId: project.id, kind: 'command',
    input: { file: process.execPath, args: ['forbidden-effect'] } },
    { id: member.id, role: 'write', projectIds: [project.id], authVersion: 1 });
  const row = service.store.get('auth-member', member.id);
  service.store.update('auth-member', member.id, { disabled: true, authVersion: row.authVersion + 1 });
  release();
  await until(() => service.store.get('job', blocker.id).status === 'completed');
  await until(() => service.store.get('job', pending.id).status === 'failed');
  assert.deepEqual(executed, []);
  assert.equal(service.store.get('job', pending.id).error.code, 'authorization_revoked');
  assert.equal(service.store.get('job', pending.id).outcome, 'not_started');
});


test('project downgrade and remove detect a connected agent after more than 1000 historical agents',async t=>{
  const {service,project,workflow}=await fixture(t);
  service.store.transaction(()=>{
    for(let i=0;i<1120;i++)service.store.create('agent',{
      projectId:project.id,workflowId:workflow.id,label:'historical-'+i,provider:'codex',status:'closed'
    });
  });
  const last=service.store.list('agent',{projectId:project.id,limit:2000}).at(-1);
  service.agents.sessions.set(last.id,{stopped:false,token:'test-session'});
  try {
    await assert.rejects(ownerCall(service,'project.update',{id:project.id,access:'read'}),{code:'project_busy'});
    await assert.rejects(ownerCall(service,'project.remove',{id:project.id}),{code:'project_busy'});
    assert.equal(service.store.get('project',project.id).access,'write');
  } finally {service.agents.sessions.delete(last.id);}
});

test('workflow resume wakes a connected agent beyond the first 1000 durable agent records',async t=>{
  const {service,project,workflow}=await fixture(t);
  service.store.transaction(()=>{
    for(let i=0;i<1120;i++)service.store.create('agent',{
      projectId:project.id,workflowId:workflow.id,label:'historical-'+i,provider:'codex',status:'closed'
    });
  });
  const last=service.store.list('agent',{workflowId:workflow.id,limit:2000}).at(-1);
  service.agents.sessions.set(last.id,{stopped:false,token:'test-session'});
  const kicks=[];
  const original=service.agents.kick;
  service.agents.kick=id=>kicks.push(id);
  try {
    await ownerCall(service,'workflow.update',{id:workflow.id,status:'active'});
    assert.deepEqual(kicks,[last.id]);
  } finally {
    service.agents.kick=original;
    service.agents.sessions.delete(last.id);
  }
});

test('task cancellation finds an affected delivery beyond 1000 unrelated deliveries',async t=>{
  const {service,project,workflow}=await fixture(t);
  const task=service.store.create('task',{projectId:project.id,workflowId:workflow.id,
    title:'target task',instruction:'target',status:'queued'});
  const message=service.store.create('message',{projectId:project.id,workflowId:workflow.id,
    sender:{kind:'user',id:'owner'},recipientIds:['agent-unconnected'],
    body:'target task',status:'queued'});
  service.store.transaction(()=>{
    for(let i=0;i<1130;i++)service.store.create('delivery',{
      projectId:project.id,workflowId:workflow.id,agentId:'unrelated-agent',
      messageId:'unrelated-message-'+i,status:'queued'
    });
  });
  const last=service.store.list('delivery',{workflowId:workflow.id,limit:2000}).at(-1);
  service.store.update('delivery',last.id,{messageId:message.id,taskId:task.id});
  const stopped=await ownerCall(service,'task.update',{id:task.id,status:'cancelled'});
  assert.equal(stopped.status,'cancelled');
  assert.equal(service.store.get('delivery',last.id).status,'cancelled');
  assert.equal(service.store.get('message',message.id).status,'cancelled');
  assert.equal(service.store.list('delivery',{workflowId:workflow.id,status:'queued',limit:2000}).length,1129);
});


test('overview counts remain exact when snapshot details are deliberately bounded',async t=>{
  const {service,project,workflow}=await fixture(t);
  service.store.transaction(()=>{
    for(let i=0;i<1250;i++)service.store.create('task',{
      projectId:project.id,workflowId:workflow.id,title:'historical-'+i,
      status:i%5===0?'completed':'queued'
    });
  });
  service.store.create('approval',{projectId:project.id,workflowId:workflow.id,status:'pending'});
  service.store.create('input',{projectId:project.id,status:'pending'});
  service.store.create('artifact',{projectId:project.id,workflowId:workflow.id,path:'report.txt',mimeType:'text/plain'});
  const snapshot=await service.snapshot({projectId:project.id,workflowId:workflow.id},testOwner);
  assert.equal(snapshot.counts.activeTasks,1000);
  assert.equal(snapshot.counts.pendingReviews,2);
  assert.equal(snapshot.counts.artifacts,1);
  assert.ok(snapshot.tasks.length<=100);
  assert.equal(service.store.count('task',{projectId:project.id,workflowId:workflow.id}),1250);
  const page=await ownerCall(service,'task.list',{projectId:project.id,workflowId:workflow.id,limit:100});
  assert.equal(page.items.length,100);
  assert.ok(page.nextCursor,'The complete detail set must remain available via pagination.');
});


test('native child retaining a channel after failed shutdown cannot send peer messages',async t=>{
  const {service,start,native,scope}=await fixture(t);
  const agent=await start('codex');
  const token=native.instances[0].options.mcpServers.find(item=>item.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  assert.equal(service.agents.channelCall(token,'agent_peers',{}).items.length,1);
  const originalClose=native.instances[0].close;
  native.instances[0].close=async()=>{throw Object.assign(new Error('child still alive'),{code:'shutdown_unconfirmed'});};
  try {
    await assert.rejects(ownerCall(service,'agents.stop',{id:agent.id}),{code:'shutdown_unconfirmed'});
    assert.throws(()=>service.agents.channelCall(token,'agent_send_message',{operationId:'revoked-agent',recipientIds:[agent.id],body:'unauthorized'}),{code:'unauthorized'});
    assert.equal(service.store.list('message',scope).length,0);
    assert.equal(service.agents.sessions.has(agent.id),true,'Keep ownership until native shutdown confirms exit.');
  } finally {
    native.instances[0].close=originalClose;
    await service.agents.stop(agent.id);
  }
});


test('event history is losslessly paginated and enforces owner/member project scopes',async t=>{
  const {service,project,workflow,temp}=await fixture(t);
  const otherRoot=path.join(temp,'other-events');fs.mkdirSync(otherRoot);
  const other=await ownerCall(service,'project.create',{root:otherRoot});
  const payload='history-'+ 'native'.repeat(1200);
  for(let i=0;i<12;i++)service.store.event('agent.native',
    {id:'agent-fixture',projectId:project.id,workflowId:workflow.id},
    {nativeEvent:{type:'message',delta:true,text:payload+'-'+i}});
  service.store.event('unrelated',{id:other.id,projectId:other.id},{private:'other'});
  const principal={id:'read-member',role:'read',projectIds:[project.id],surface:'mcp'};
  let cursor=0;const all=[];
  do {
    const page=await service.call('event.list',{projectId:project.id,workflowId:workflow.id,
      cursor,limit:4},principal);
    all.push(...page.items);
    cursor=page.nextCursor;
  } while(cursor);
  const native=all.filter(item=>item.type==='agent.native');
  assert.equal(native.length,12);
  assert.deepEqual(native.map(item=>item.nativeEvent.text),
    Array.from({length:12},(_,i)=>payload+'-'+i));
  assert.ok(all.every(item=>item.projectId===project.id));
  await assert.rejects(service.call('event.list',{projectId:other.id},principal),{code:'forbidden'});
  await assert.rejects(ownerCall(service,'event.list',{projectId:project.id,workflowId:'workflow-not-real'}),{code:'not_found'});
});


test('Codex and Claude bridge messages are queued while a recipient is busy and delivered exactly once',async t=>{
  const { service, scope, start, native } = await fixture(t);
  const codex=await start('codex');
  const claude=await start('claude');
  const codexAdapter=native.instances[0], claudeAdapter=native.instances[1];
  const codexToken=codexAdapter.options.mcpServers.find(s=>s.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const claudeToken=claudeAdapter.options.mcpServers.find(s=>s.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  codexAdapter.mode='wait';
  const original=await ownerCall(service,'message.send',{
    ...scope,recipientIds:[codex.id],body:'Implement this change'
  });
  await until(()=>!!codexAdapter.finish,'Codex native turn running');
  const request=service.agents.channelCall(codexToken,'agent_send_message',{
    operationId:'codex-review-request',recipientIds:[claude.id],body:'Please review my patch'
  });
  await until(()=>service.store.get('message',request.id).status==='delivered','Claude review delivered');
  assert.match(claudeAdapter.calls[0],/Message from codex/);
  const reply=service.agents.channelCall(claudeToken,'agent_send_message',{
    operationId:'claude-review-answer',recipientIds:[codex.id],body:'Reviewed: please adjust the test'
  });
  assert.equal(service.store.get('message',reply.id).status,'queued',
    'A busy Codex native session should not be interrupted by unsolicited cross-provider delivery');
  assert.equal(codexAdapter.calls.length,1);
  codexAdapter.mode='complete';
  codexAdapter.finish({status:'completed',text:'First turn completed',native:{status:'completed'}});
  await until(()=>service.store.get('message',original.id).status==='delivered','Codex initial completion');
  await until(()=>service.store.get('message',reply.id).status==='delivered','Codex received Claude review');
  assert.equal(codexAdapter.calls.length,2);
  assert.match(codexAdapter.calls[1],/Message from claude/);
  assert.match(codexAdapter.calls[1],/Reviewed: please adjust the test/);
  const second=service.store.deliveriesForMessage(reply.id);
  assert.equal(second.length,1);
  assert.equal(second[0].status,'delivered');
  assert.equal(service.store.get('job',second[0].jobId).status,'completed');
  assert.equal(reply.sender.id,claude.id);
});


test('parallel native child approvals keep the parent Agent waiting until every request resolves',async t=>{
  const {service,start,scope}=await fixture(t);
  const agent=await start('codex');
  const session=service.agents.sessions.get(agent.id);
  session.current={id:'job-parallel-approvals'};
  service.store.update('agent',agent.id,{status:'running'});
  const first=service.agents.request(agent.id,'approval',{
    id:'child-one-request',kind:'Write',options:[{optionId:'allow'}],
    threadId:'child-one',details:{path:'one.txt'}
  });
  const second=service.agents.request(agent.id,'approval',{
    id:'child-two-request',kind:'Write',options:[{optionId:'allow'}],
    threadId:'child-two',details:{path:'two.txt'}
  });
  let stateAfterFirst;
  try {
    const approvals=service.store.list('approval',scope);
    assert.equal(approvals.length,2);
    const firstApproval=approvals.find(item=>item.nativeRequestId==='child-one-request');
    const secondApproval=approvals.find(item=>item.nativeRequestId==='child-two-request');
    assert.ok(firstApproval && secondApproval);
    assert.equal(service.store.get('agent',agent.id).status,'waiting');
    await ownerCall(service,'approval.resolve',{id:firstApproval.id,optionId:'allow'});
    assert.deepEqual(await first,{optionId:'allow'});
    stateAfterFirst=service.store.get('agent',agent.id).status;
    await ownerCall(service,'approval.resolve',{id:secondApproval.id,optionId:'allow'});
    assert.deepEqual(await second,{optionId:'allow'});
    assert.equal(service.store.get('agent',agent.id).status,'running');
  } finally {
    for (const item of service.store.list('approval',scope).filter(item=>item.status==='pending')) {
      await ownerCall(service,'approval.resolve',{id:item.id,optionId:'allow'});
    }
    await Promise.allSettled([first,second]);
    session.current=null;
  }
  assert.equal(stateAfterFirst,'waiting',
    'Resolving one native subagent must not mask a different pending human decision');
});


test('aborting one of two independent native approvals does not dismiss the second or wake its Agent',async t=>{
  const {service,start,scope}=await fixture(t);
  const agent=await start('codex');
  const session=service.agents.sessions.get(agent.id);
  session.current={id:'job-two-requests'};
  service.store.update('agent',agent.id,{status:'running'});
  const firstController=new AbortController();
  const first=service.agents.request(agent.id,'approval',
    {id:'native-first',kind:'Write',options:[{optionId:'allow'}]}, {signal:firstController.signal});
  const second=service.agents.request(agent.id,'approval',
    {id:'native-second',kind:'Write',options:[{optionId:'allow'}]});
  const firstOutcome=first.catch(error=>error);
  const secondOutcome=second.catch(error=>error);
  try {
    firstController.abort();
    assert.equal((await firstOutcome).code,'request_expired');
    assert.equal(service.store.get('agent',agent.id).status,'waiting');
    const approved=service.store.list('approval',scope);
    assert.equal(approved.filter(item=>item.status==='expired').length,1);
    assert.equal(approved.filter(item=>item.status==='pending').length,1);
    const secondItem=approved.find(item=>item.status==='pending');
    await ownerCall(service,'approval.resolve',{id:secondItem.id,optionId:'allow'});
    assert.deepEqual(await secondOutcome,{optionId:'allow'});
    assert.equal(service.store.get('agent',agent.id).status,'running');
  } finally {
    for (const item of service.store.list('approval',scope).filter(x=>x.status==='pending'))
      await ownerCall(service,'approval.resolve',{id:item.id,optionId:'allow'});
    await Promise.allSettled([first,second]);
    session.current=null;
  }
});

test('a native Agent cannot open fresh approvals outside a running owned turn',async t=>{
  const {service,start,scope}=await fixture(t);
  const agent=await start('codex');
  const decision=service.agents.request(agent.id,'approval',{
    id:'too-late',kind:'Write',options:[{optionId:'allow'}],details:{path:'outside-turn.txt'}
  });
  const result=decision.catch(error=>error);
  const exposed=service.store.list('approval',scope);
  try {
    for (const item of exposed.filter(item=>item.status==='pending'))
      await ownerCall(service,'approval.resolve',{id:item.id,optionId:'allow'});
    const outcome=await result;
    assert.equal(outcome.code,'request_expired');
    assert.equal(exposed.length,0,'No user approval request should be created for an idle Agent');
    assert.equal(service.store.get('agent',agent.id).status,'ready');
  } finally {
    for (const item of service.store.list('approval',scope).filter(item=>item.status==='pending'))
      await ownerCall(service,'approval.resolve',{id:item.id,optionId:'allow'});
    await Promise.allSettled([decision]);
  }
});

test('native cancel returning not-requested must not clear other pending child approvals',async t=>{
  const {service,start,scope}=await fixture(t);
  const agent=await start('codex');
  const session=service.agents.sessions.get(agent.id);
  session.current={id:'job-cancel-noop'};
  service.store.update('agent',agent.id,{status:'running'});
  session.adapter.cancel=async()=>({requested:false});
  const decision=service.agents.request(agent.id,'approval',{
    id:'still-waiting',kind:'Write',options:[{optionId:'allow'}]
  });
  try {
    assert.equal((await service.agents.cancel(agent.id)).requested,false);
    assert.equal(service.store.get('agent',agent.id).status,'waiting');
  } finally {
    const item=service.store.list('approval',scope).find(x=>x.status==='pending');
    if(item) await ownerCall(service,'approval.resolve',{id:item.id,optionId:'allow'});
    await Promise.allSettled([decision]);
    session.current=null;
  }
});


test('a repeated Agent MCP send with the same operation ID commits one delivery and never consumes a second turn',async t=>{
  const {service,scope,start,native}=await fixture(t);
  const sender=await start('codex'),receiver=await start('claude');
  const token=native.instances[0].options.mcpServers.find(item=>item.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const input={operationId:'send-review-001',recipientIds:[receiver.id],body:'Review the implementation once'};
  const first=service.agents.channelCall(token,'agent_send_message',input);
  const retry=service.agents.channelCall(token,'agent_send_message',{...input});
  assert.deepEqual(retry,first,'A lost response may cause retries; it must not create another message.');
  await until(()=>service.store.get('message',first.id).status==='delivered','native recipient completed');
  const later=service.agents.channelCall(token,'agent_send_message',input);
  assert.equal(later.id,first.id);
  assert.equal(native.instances[1].calls.length,1);
  assert.equal(service.store.deliveriesForMessage(first.id).length,1);
  assert.equal(service.store.get('workflow',scope.workflowId).usedTurns,1);
  assert.throws(()=>service.agents.channelCall(token,'agent_send_message',{
    ...input,body:'Different payload with reused id'
  }),{code:'operation_conflict'});
  const otherSenderToken=native.instances[1].options.mcpServers.find(item=>item.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const distinct=service.agents.channelCall(otherSenderToken,'agent_send_message',{
    operationId:input.operationId,recipientIds:[sender.id],body:'Distinct sender, same local operation ID'
  });
  assert.notEqual(distinct.id,first.id,'Independent senders own separate idempotency namespaces');
});


test('native Agent send idempotency survives runtime reboot even after the former receiver disconnects',async t=>{
  const {service,start,native,scope,stateRoot}=await fixture(t);
  const sender=await start('codex'),receiver=await start('claude');
  const senderToken=native.instances[0].options.mcpServers.find(item=>item.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const input={operationId:'after-restart-001',recipientIds:[receiver.id],body:'Review this once across a restart'};
  const created=service.agents.channelCall(senderToken,'agent_send_message',input);
  await until(()=>service.store.get('message',created.id).status==='delivered','original delivery');
  await service.close();service.testClosed=true;
  const reopened=new DevMateService({instanceRoot:stateRoot,adapterFactory:native.factory});
  try {
    await reopened.ready;
    const before={
      messages:reopened.store.count('message',scope),
      deliveries:reopened.store.count('delivery',scope),
      jobs:reopened.store.count('job',scope),
      turns:reopened.store.get('workflow',scope.workflowId).usedTurns
    };
    const replayed=reopened.agents.send({...scope,...input},{
      kind:'agent',id:sender.id,label:'codex',provider:'codex'
    });
    assert.equal(replayed.id,created.id);
    assert.deepEqual({
      messages:reopened.store.count('message',scope),
      deliveries:reopened.store.count('delivery',scope),
      jobs:reopened.store.count('job',scope),
      turns:reopened.store.get('workflow',scope.workflowId).usedTurns
    },before);
  } finally { await reopened.close(); }
});


test('agent sends roll back both messages and turn budget when the durable idempotency receipt fails',async t=>{
  const {service,start,native,scope}=await fixture(t);
  await start('codex');const receiver=await start('claude');
  const token=native.instances[0].options.mcpServers.find(item=>item.name==='devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const input={operationId:'atomic-send-test',recipientIds:[receiver.id],body:'Review after durable commit'};
  const original=service.store.saveOperation.bind(service.store);
  service.store.saveOperation=(id,name,fingerprint,result)=>{
    if(name==='agent_send_message')throw new Error('simulated receipt commit failure');
    return original(id,name,fingerprint,result);
  };
  try {
    assert.throws(()=>service.agents.channelCall(token,'agent_send_message',input),
      /simulated receipt commit failure/);
  } finally {service.store.saveOperation=original;}
  await delay(10);
  assert.equal(service.store.count('message',scope),0);
  assert.equal(service.store.count('delivery',scope),0);
  assert.equal(service.store.get('workflow',scope.workflowId).usedTurns,0);
  assert.equal(native.instances[1].calls.length,0);
  const sent=service.agents.channelCall(token,'agent_send_message',input);
  await until(()=>service.store.get('message',sent.id).status==='delivered');
  assert.equal(service.store.count('delivery',scope),1);
  assert.equal(native.instances[1].calls.length,1);
});


test('failed SQLite approval-state transaction never dispatches a partial or duplicated native decision',async t=>{
  const {service,start,scope}=await fixture(t);
  const agent=await start('codex');
  const session=service.agents.sessions.get(agent.id);
  session.current={id:'transactional-native-approval'};
  service.store.update('agent',agent.id,{status:'running'});
  const decision=service.agents.request(agent.id,'approval',{
    id:'one-approval',kind:'Write',options:[{optionId:'allow'}]
  });
  const pending=decision.catch(error=>error);
  const approval=service.store.list('approval',scope)[0];
  const original=service.store.update.bind(service.store);
  let faults=0;
  service.store.update=(kind,id,patch,expectedRevision)=>{
    if(kind==='agent' && patch.status==='running' && faults++===0)
      throw new Error('simulated SQLite status persistence fault');
    return original(kind,id,patch,expectedRevision);
  };
  try {
    await assert.rejects(ownerCall(service,'approval.resolve',{
      id:approval.id,optionId:'allow',expectedRevision:approval.revision
    }),/simulated SQLite status persistence fault/);
    assert.equal(service.store.get('approval',approval.id).status,'pending',
      'The approval row and Agent state must roll back as one unit');
    assert.equal(service.store.get('agent',agent.id).status,'waiting');
    assert.equal(service.agents.decisions.has(approval.id),true);
  } finally {service.store.update=original;}
  try {
    await ownerCall(service,'approval.resolve',{
      id:approval.id,optionId:'allow',expectedRevision:approval.revision
    });
    assert.deepEqual(await pending,{optionId:'allow'});
    assert.equal(service.store.get('agent',agent.id).status,'running');
  } finally {
    for(const item of service.store.list('approval',scope).filter(item=>item.status==='pending'))
      await ownerCall(service,'approval.resolve',{id:item.id,optionId:'allow'});
    await Promise.allSettled([decision]);
    session.current=null;
  }
});
