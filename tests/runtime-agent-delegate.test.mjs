import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../runtime/store.mjs';
import { AgentCoordinator } from '../runtime/coordination.mjs';

const owner = Object.freeze({ kind: 'user', id: 'owner', label: 'You' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'condition', timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out: ' + label);
    await delay(5);
  }
}
// A native adapter stand-in: each instance is one owned agent process. No model is involved.
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-agent-delegate-'));
  const store = new Store(path.join(root, 'instance'));
  const projectRoot = path.join(root, 'project'); fs.mkdirSync(projectRoot);
  const project = store.create('project', { name: 'Delegation', root: projectRoot, access: 'write', status: 'ready' });
  const instances = [];
  const factory = adapterOptions => {
    const instance = { options: adapterOptions, prompts: [], cancels: 0, closed: false, mode: factory.mode || 'complete',
      capabilities: { steer: false, approvals: true, mcp: true, ...factory.capabilities },
      async start({ sessionId } = {}) {
        instance.resumed = sessionId || null;
        if (instance.mode === 'missing') throw Object.assign(new Error('codex is not installed'), { code: 'agent_not_installed' });
        return { sessionId: sessionId || 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities };
      },
      async send({ text }) {
        instance.prompts.push(text);
        if (instance.mode === 'hold') return new Promise((resolve, reject) => { instance.finish = resolve; instance.fail = reject; });
        if (instance.mode === 'approval' || instance.mode === 'input') {
          instance.controller = new AbortController();
          const ask = instance.mode === 'approval'
            ? adapterOptions.onApproval({ id: 'native-approval', kind: 'Bash', summary: 'Bash: rm -rf build', details: { command: 'rm -rf build' }, native: { secret: 'raw' },
              options: [{ optionId: 'allow', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }] }, { signal: instance.controller.signal })
            : adapterOptions.onInput({ id: 'native-question', kind: 'AskUserQuestion', summary: 'Which database should the migration target?',
              details: { questions: [{ question: 'Which database should the migration target?' }] }, native: {} }, { signal: instance.controller.signal });
          try { instance.answer = await ask; } catch { return { status: 'interrupted' }; }
        }
        return { status: 'completed', text: typeof instance.reply === 'string' ? instance.reply : 'done: ' + text };
      },
      async cancel() { instance.cancels++; instance.controller?.abort(); if (!instance.ignoreCancel) instance.finish?.({ status: 'interrupted' }); return { requested: true }; },
      async close() { instance.closed = true; instance.controller?.abort(); instance.finish?.({ status: 'interrupted', outcome: 'unconfirmed' }); }
    };
    if (factory.capabilities?.process === 'per-turn') instance.setMcpServer = server => { instance.channel = server; };
    instances.push(instance);
    return instance;
  };
  const coordinator = new AgentCoordinator({ store, adapterFactory: factory, endpoint: 'http://127.0.0.1:1/api/agent', ...options });
  t.after(async () => { await coordinator.close(); store.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const delegate = (input, sender = owner) => coordinator.delegate({ projectId: project.id, ...input }, sender);
  const tokenOf = instance => instance.options.mcpServers.find(server => server.name === 'devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  return { root, store, project, coordinator, factory, instances, delegate, tokenOf };
}

test('one call starts an agent and returns its answer; the next call continues the same session', async t => {
  const f = fixture(t);
  const first = await f.delegate({ provider: 'claude', prompt: 'Fix the failing test\nDetails follow', waitMs: 5000, caller: 'owner' });
  assert.equal(first.settled, true); assert.equal(first.status, 'ready'); assert.equal(first.provider, 'claude');
  assert.equal(first.output, 'done: Fix the failing test\nDetails follow'); assert.equal(first.outputTruncated, false);
  assert.equal(first.turn.status, 'completed'); assert.equal(first.turn.jobId, first.jobId); assert.ok(first.turn.finishedAt);
  assert.deepEqual(first.approvals, []); assert.deepEqual(first.inputs, []); assert.equal(first.error, undefined);
  assert.equal(f.store.get('delivery', first.deliveryId).jobId, first.jobId);
  assert.equal(f.store.get('workflow', first.workflowId).title, 'Delegated: Fix the failing test');
  assert.equal(f.store.get('agent', first.agentId).caller, 'owner');
  assert.equal(f.instances[0].options.cwd, f.project.root);
  const again = await f.delegate({ agentId: first.agentId, prompt: 'Now add a regression test', waitMs: 5000 });
  assert.equal(again.agentId, first.agentId); assert.equal(again.workflowId, first.workflowId);
  assert.equal(again.output, 'done: Now add a regression test'); assert.notEqual(again.jobId, first.jobId);
  assert.equal(f.instances.length, 1, 'the same native session is reused');
  assert.equal(f.store.get('workflow', first.workflowId).usedTurns, 2);
  await assert.rejects(f.delegate({ prompt: 'no provider' }), { code: 'invalid_input' });
  await assert.rejects(f.delegate({ agentId: first.agentId, provider: 'codex', prompt: 'wrong provider' }), { code: 'invalid_input' });
  await assert.rejects(f.coordinator.delegate({ projectId: 'project-elsewhere', agentId: first.agentId, prompt: 'cross project' }, owner), { code: 'scope_mismatch' });
  await assert.rejects(f.delegate({ provider: 'codex', model: '--yolo', prompt: 'bad model' }), { code: 'invalid_input' });
  assert.equal(f.store.count('workflow', { projectId: f.project.id }), 1, 'a refused delegate leaves no workflow behind');
});

test('each delegate receives the answer of exactly its own task, whatever else the agent is given meanwhile', async t => {
  const f = fixture(t); f.factory.mode = 'hold';
  const a = await f.delegate({ provider: 'codex', prompt: 'Task A', waitMs: 0 });
  assert.equal(a.settled, false); assert.equal(a.output, ''); assert.ok(a.deliveryId);
  const agent = f.instances[0];
  await until(() => agent.prompts.length === 1, 'task A running');
  const b = await f.delegate({ agentId: a.agentId, prompt: 'Task B', waitMs: 50 });
  assert.equal(b.settled, false); assert.equal(b.jobId, null, 'task B is still queued behind task A'); assert.notEqual(b.deliveryId, a.deliveryId);
  const peer = f.coordinator.send({ projectId: f.project.id, workflowId: a.workflowId, recipientIds: [a.agentId], body: 'Peer note' }, owner);
  assert.deepEqual(peer.deliveries.map(item => item.agentId), [a.agentId]);
  const waitA = f.coordinator.outcome(a.agentId, { deliveryId: a.deliveryId, waitMs: 5000 });
  const waitB = f.coordinator.outcome(a.agentId, { deliveryId: b.deliveryId, waitMs: 5000 });
  agent.finish({ status: 'completed', text: 'answer A' });
  const doneA = await waitA;
  assert.equal(doneA.settled, true); assert.equal(doneA.output, 'answer A'); assert.equal(doneA.turn.status, 'completed');
  await until(() => agent.prompts.length === 2, 'task B running');
  assert.equal((await f.coordinator.outcome(a.agentId, { deliveryId: a.deliveryId })).output, 'answer A', 'A keeps its own answer while B runs');
  agent.finish({ status: 'completed', text: 'answer B' });
  const doneB = await waitB;
  assert.equal(doneB.output, 'answer B'); assert.notEqual(doneB.jobId, doneA.jobId);
  await until(() => agent.prompts.length === 3, 'peer note running');
  agent.finish({ status: 'completed', text: 'peer reply' });
  await until(() => f.store.get('message', peer.id).status === 'delivered', 'peer note delivered');
  assert.equal((await f.coordinator.outcome(a.agentId, { jobId: doneA.jobId })).output, 'answer A');
  assert.equal((await f.coordinator.outcome(a.agentId, { jobId: doneB.jobId })).output, 'answer B');
  assert.equal((await f.coordinator.outcome(a.agentId)).output, 'peer reply', 'without a task id the most recent task is reported');
  const other = await f.delegate({ provider: 'claude', prompt: 'elsewhere', waitMs: 0 });
  await assert.rejects(f.coordinator.outcome(other.agentId, { jobId: doneA.jobId }), { code: 'scope_mismatch' });
  await assert.rejects(f.coordinator.outcome(other.agentId, { deliveryId: a.deliveryId }), { code: 'scope_mismatch' });
});

test('the returned answer is bounded to its end and says so', async t => {
  const f = fixture(t); f.factory.mode = 'hold';
  const pending = await f.delegate({ provider: 'codex', prompt: 'write a lot', waitMs: 0 });
  await until(() => f.instances[0].finish, 'turn running');
  f.instances[0].finish({ status: 'completed', text: 'start-' + 'x'.repeat(70000) + '-THE END' });
  const done = await f.coordinator.outcome(pending.agentId, { deliveryId: pending.deliveryId, waitMs: 5000 });
  assert.equal(done.output.length, 60000); assert.ok(done.output.endsWith('-THE END')); assert.equal(done.outputTruncated, true);
  assert.ok(f.store.get('job', done.jobId).output.startsWith('start-'), 'the job itself keeps the whole answer');
});

test('a resume that fails settles the new task with the reason instead of returning the previous answer', async t => {
  const f = fixture(t);
  const first = await f.delegate({ provider: 'codex', prompt: 'First task', waitMs: 5000 });
  assert.equal(first.output, 'done: First task');
  await f.coordinator.stop(first.agentId);
  f.factory.mode = 'missing';
  const started = Date.now();
  const failed = await f.delegate({ agentId: first.agentId, prompt: 'Second task', waitMs: 20000 });
  assert.ok(Date.now() - started < 5000, 'a failed start ends the wait');
  assert.equal(failed.settled, true); assert.equal(failed.status, 'unavailable'); assert.equal(failed.output, '');
  assert.equal(failed.turn, null); assert.equal(failed.jobId, null); assert.equal(failed.error.code, 'agent_not_installed');
  assert.notEqual(failed.deliveryId, first.deliveryId);
  const delivery = f.store.get('delivery', failed.deliveryId);
  assert.equal(delivery.status, 'failed'); assert.equal(delivery.error.code, 'agent_not_installed');
  assert.equal(f.store.get('message', delivery.messageId).status, 'failed');
  assert.equal(f.store.get('workflow', first.workflowId).usedTurns, 1, 'a turn that never ran is given back');
  assert.equal(f.coordinator.sessions.size, 0);
  f.factory.mode = 'complete';
  const third = await f.delegate({ agentId: first.agentId, prompt: 'Third task', waitMs: 5000 });
  assert.equal(third.output, 'done: Third task', 'an unavailable agent is resumable');
  assert.equal(f.instances[2].resumed, 'native-0'); assert.deepEqual(f.instances[2].prompts, ['Third task']);
  f.factory.mode = 'missing';
  const fresh = await f.delegate({ provider: 'gemini', prompt: 'never starts', waitMs: 5000 });
  assert.equal(fresh.settled, true); assert.equal(fresh.status, 'unavailable'); assert.equal(fresh.turn, null); assert.equal(fresh.error.code, 'agent_not_installed');
});

test('an agent whose process died is released and resumes on the next delegate', async t => {
  const f = fixture(t);
  const first = await f.delegate({ provider: 'codex', prompt: 'one', waitMs: 5000 });
  const token = f.tokenOf(f.instances[0]);
  assert.equal(f.coordinator.channelCall(token, 'agent_peers', {}).items.length, 1);
  // The app-server exits while the agent is idle.
  f.instances[0].options.onEvent({ type: 'state', state: 'disconnected', exit: { code: 1, signal: null } });
  const dead = f.store.get('agent', first.agentId);
  assert.equal(dead.status, 'disconnected'); assert.equal(dead.error.code, 'process_exited'); assert.match(dead.error.message, /code 1/);
  assert.throws(() => f.coordinator.channelCall(token, 'agent_peers', {}), { code: 'unauthorized' }, 'the channel token dies with the process');
  await until(() => !f.coordinator.sessions.has(first.agentId), 'session released');
  assert.equal(f.instances[0].closed, true); assert.equal(f.coordinator.tokens.size, 0);
  const second = await f.delegate({ agentId: first.agentId, prompt: 'two', waitMs: 5000 });
  assert.equal(second.output, 'done: two'); assert.equal(second.status, 'ready');
  assert.equal(f.instances.length, 2); assert.equal(f.instances[1].resumed, 'native-0');
  assert.notEqual(f.tokenOf(f.instances[1]), token);
  // A plain message wakes a disconnected agent the same way, so a peer can still reach it.
  f.instances[1].options.onEvent({ type: 'state', state: 'disconnected', exit: { code: null, signal: 'SIGKILL' } });
  const scope = { projectId: f.project.id, workflowId: first.workflowId };
  const woken = f.coordinator.send({ ...scope, recipientIds: [first.agentId], body: 'three' }, owner);
  assert.equal((await f.coordinator.outcome(first.agentId, { deliveryId: woken.deliveries[0].id, waitMs: 5000 })).output, 'done: three');
  assert.equal(f.instances.length, 3); assert.deepEqual(f.instances[2].prompts, ['three']);
  // An agent whose start failed is not retried by every message, and a stopped one stays stopped.
  f.factory.mode = 'missing';
  f.instances[2].options.onEvent({ type: 'state', state: 'disconnected', exit: { code: 1, signal: null } });
  const failed = f.coordinator.send({ ...scope, recipientIds: [first.agentId], body: 'four' }, owner);
  assert.equal((await f.coordinator.outcome(first.agentId, { deliveryId: failed.deliveries[0].id, waitMs: 5000 })).status, 'unavailable');
  const turns = f.store.get('workflow', first.workflowId).usedTurns;
  assert.throws(() => f.coordinator.send({ ...scope, recipientIds: [first.agentId], body: 'five' }, owner),
    { code: 'agent_disconnected', message: 'Agent codex is unavailable. Resume it before sending a message.' });
  assert.equal(f.store.get('workflow', first.workflowId).usedTurns, turns, 'a refused message spends no turn');
  assert.equal(f.instances.length, 4);
  await f.coordinator.stop(first.agentId);
  assert.throws(() => f.coordinator.send({ ...scope, recipientIds: [first.agentId], body: 'six' }, owner), { code: 'agent_closed' });
});

test('an unknown turn outcome closes the adapter, settles the task and leaves the agent resumable', async t => {
  const f = fixture(t); f.factory.mode = 'hold';
  const running = await f.delegate({ provider: 'codex', prompt: 'three', waitMs: 0 });
  const agent = f.instances[0];
  await until(() => agent.fail, 'turn running');
  const queued = f.coordinator.send({ projectId: f.project.id, workflowId: running.workflowId, recipientIds: [running.agentId], body: 'queued behind it' }, owner);
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 2);
  const waiting = f.coordinator.outcome(running.agentId, { deliveryId: running.deliveryId, waitMs: 20000 });
  // As the real adapters do: they report the lost connection, then reject the turn with its cause.
  agent.options.onEvent({ type: 'state', state: 'disconnected' });
  agent.fail(Object.assign(new Error('turn/start timed out; outcome is unknown'), { code: 'request_timeout' }));
  const lost = await waiting;
  assert.equal(lost.settled, true); assert.equal(lost.turn.status, 'unknown'); assert.equal(lost.status, 'disconnected');
  assert.equal(lost.error.code, 'request_timeout');
  await until(() => !f.coordinator.sessions.has(running.agentId), 'session released');
  assert.equal(agent.closed, true); assert.equal(f.coordinator.tokens.size, 0);
  const dropped = f.store.get('delivery', queued.deliveries[0].id);
  assert.equal(dropped.status, 'cancelled'); assert.equal(dropped.error.code, 'request_timeout');
  assert.equal(f.store.get('message', queued.id).status, 'cancelled');
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 1, 'only the turn that ran stays spent');
  f.factory.mode = 'complete';
  const resumed = await f.delegate({ agentId: running.agentId, prompt: 'FRESH', waitMs: 5000 });
  assert.equal(resumed.output, 'done: FRESH'); assert.deepEqual(f.instances[1].prompts, ['FRESH'], 'nothing stale runs before the new task');
});

test('a pending approval or question ends the wait and is listed with what it is about', async t => {
  const f = fixture(t);
  f.factory.mode = 'approval';
  let started = Date.now();
  const blocked = await f.delegate({ provider: 'claude', prompt: 'Clean the build', waitMs: 20000 });
  assert.ok(Date.now() - started < 5000, 'an approval request ends the wait');
  assert.equal(blocked.status, 'waiting'); assert.equal(blocked.settled, false); assert.deepEqual(blocked.inputs, []);
  assert.deepEqual(blocked.approvals.map(({ summary, options }) => ({ summary, options })), [{ summary: 'Bash: rm -rf build', options: ['Allow once', 'Deny'] }]);
  const stored = f.store.get('approval', blocked.approvals[0].id);
  assert.equal(stored.summary, 'Bash: rm -rf build'); assert.deepEqual(stored.details, { command: 'rm -rf build' });
  assert.equal(stored.native, undefined, 'the raw native request is not persisted');
  f.coordinator.resolve('approval', { id: blocked.approvals[0].id, optionId: 'allow' });
  const approved = await f.coordinator.outcome(blocked.agentId, { jobId: blocked.jobId, waitMs: 5000 });
  assert.equal(approved.settled, true); assert.equal(approved.output, 'done: Clean the build'); assert.deepEqual(approved.approvals, []);
  f.factory.mode = 'input';
  started = Date.now();
  const asked = await f.delegate({ provider: 'codex', prompt: 'Run the migration', waitMs: 20000 });
  assert.ok(Date.now() - started < 5000, 'a question ends the wait');
  assert.equal(asked.status, 'waiting'); assert.equal(asked.settled, false); assert.deepEqual(asked.approvals, []);
  assert.deepEqual(asked.inputs.map(item => item.summary), ['Which database should the migration target?']);
  const watching = f.coordinator.outcome(asked.agentId, { deliveryId: asked.deliveryId, waitMs: 20000 });
  assert.equal((await watching).inputs.length, 1, 'a later wait returns at once while the question is open');
  f.coordinator.resolve('input', { id: asked.inputs[0].id, response: { answers: { db: 'postgres' } } });
  const answered = await f.coordinator.outcome(asked.agentId, { deliveryId: asked.deliveryId, waitMs: 5000 });
  assert.equal(answered.settled, true); assert.deepEqual(answered.inputs, []);
  assert.deepEqual(f.instances[1].answer, { answers: { db: 'postgres' } });
});

test('a native request the provider withdraws is marked expired and can no longer be answered', async t => {
  const f = fixture(t); f.factory.mode = 'approval';
  const blocked = await f.delegate({ provider: 'claude', prompt: 'Needs approval', waitMs: 5000 });
  const id = blocked.approvals[0].id;
  // What the Claude bridge does when Claude's connection to the permission tool closes.
  f.instances[0].controller.abort();
  assert.equal(f.store.get('approval', id).status, 'expired');
  assert.throws(() => f.coordinator.resolve('approval', { id, optionId: 'allow' }), { code: 'request_expired' });
  const after = await f.coordinator.outcome(blocked.agentId, { jobId: blocked.jobId, waitMs: 5000 });
  assert.deepEqual(after.approvals, []); assert.equal(after.settled, true); assert.equal(after.turn.status, 'cancelled');
});

test('a prompt given at start is a queued task from the first moment: it fails with a failed start and respects the budget', async t => {
  const f = fixture(t);
  const workflow = f.store.create('workflow', { projectId: f.project.id, title: 'One turn', status: 'active', turnBudget: 1, usedTurns: 0 });
  const scope = { projectId: f.project.id, workflowId: workflow.id };
  f.factory.mode = 'missing';
  const broken = f.coordinator.start({ ...scope, provider: 'codex', prompt: 'First', caller: 'owner' });
  const failed = await f.coordinator.outcome(broken.id, { waitMs: 5000 });
  assert.equal(failed.settled, true); assert.equal(failed.status, 'unavailable'); assert.equal(failed.error.code, 'agent_not_installed');
  assert.equal(f.store.get('delivery', failed.deliveryId).status, 'failed');
  assert.equal(f.store.get('workflow', workflow.id).usedTurns, 0);
  f.factory.mode = 'complete';
  const working = f.coordinator.start({ ...scope, provider: 'codex', prompt: 'Uses the only turn' });
  assert.equal((await f.coordinator.outcome(working.id, { waitMs: 5000 })).output, 'done: Uses the only turn');
  const agents = f.store.count('agent', scope);
  assert.throws(() => f.coordinator.start({ ...scope, provider: 'codex', prompt: 'Over budget' }), { code: 'workflow_budget' });
  assert.equal(f.store.count('agent', scope), agents, 'a start that cannot run its prompt creates no agent');
  await assert.rejects(f.coordinator.delegate({ ...scope, provider: 'codex', prompt: 'Over budget too' }, owner), { code: 'workflow_budget' });
  await assert.rejects(f.coordinator.delegate({ projectId: f.project.id, agentId: working.id, prompt: 'Still over budget' }, owner), { code: 'workflow_budget' });
  assert.equal(f.instances.length, 2);
});

test('stopping an agent cancels what was queued for it and gives those turns back', async t => {
  const f = fixture(t); f.factory.mode = 'hold';
  const running = await f.delegate({ provider: 'codex', prompt: 'long task', waitMs: 0 });
  await until(() => f.instances[0].finish, 'turn running');
  const scope = { projectId: f.project.id, workflowId: running.workflowId };
  const task = f.store.create('task', { ...scope, title: 'Queued task', instruction: 'later', assigneeId: running.agentId, status: 'queued' });
  const stale = [f.coordinator.send({ ...scope, recipientIds: [running.agentId], body: 'stale one' }, owner),
    f.coordinator.send({ ...scope, recipientIds: [running.agentId], body: 'stale two', taskId: task.id }, owner)];
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 3);
  const stopped = await f.coordinator.stop(running.agentId);
  assert.equal(stopped.status, 'closed');
  for (const message of stale) {
    assert.equal(f.store.get('message', message.id).status, 'cancelled');
    const delivery = f.store.get('delivery', message.deliveries[0].id);
    assert.equal(delivery.status, 'cancelled'); assert.equal(delivery.error.code, 'agent_stopped');
  }
  assert.equal(f.store.get('task', task.id).status, 'cancelled');
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 1);
  assert.equal((await f.coordinator.outcome(running.agentId, { deliveryId: stale[0].deliveries[0].id })).settled, true);
  f.factory.mode = 'complete';
  const fresh = await f.delegate({ agentId: running.agentId, prompt: 'FRESH', waitMs: 5000 });
  assert.equal(fresh.output, 'done: FRESH'); assert.deepEqual(f.instances[1].prompts, ['FRESH']);
});

test('an agent cannot message itself, and a withdrawn delivery gives its turn back', async t => {
  const f = fixture(t); f.factory.mode = 'hold';
  const running = await f.delegate({ provider: 'codex', prompt: 'one', waitMs: 0 });
  const agent = f.instances[0];
  await until(() => agent.finish, 'turn running');
  const before = f.store.count('message', { projectId: f.project.id });
  assert.throws(() => f.coordinator.channelCall(f.tokenOf(agent), 'agent_send_message', { operationId: 'self-1', recipientIds: [running.agentId], body: 'note to self' }),
    { code: 'invalid_input', message: 'An agent cannot send a message to itself.' });
  assert.equal(f.store.count('message', { projectId: f.project.id }), before);
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 1);
  const queued = f.coordinator.send({ projectId: f.project.id, workflowId: running.workflowId, recipientIds: [running.agentId], body: 'withdraw me' }, owner);
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 2);
  assert.equal(f.coordinator.cancelQueued(queued.deliveries[0].id).status, 'cancelled');
  assert.equal(f.store.get('message', queued.id).status, 'cancelled');
  assert.equal(f.store.get('workflow', running.workflowId).usedTurns, 1);
  agent.finish({ status: 'completed', text: 'one done' });
  await f.coordinator.outcome(running.agentId, { deliveryId: running.deliveryId, waitMs: 5000 });
  await until(() => !f.coordinator.sessions.get(running.agentId).draining, 'drain finished');
  assert.deepEqual(agent.prompts, ['one'], 'the withdrawn message never ran');
  assert.equal(f.coordinator.cancelQueued(running.deliveryId).status, 'delivered', 'a delivery that already ran is left as it is');
});

test('idle sessions are disconnected after their time-to-live and stay resumable; busy ones are kept', async t => {
  const f = fixture(t, { providerSettings: { codex: { sessionIdleMs: 150 } } });
  const first = await f.delegate({ provider: 'codex', prompt: 'quick', waitMs: 5000 });
  assert.equal(f.coordinator.sessions.size, 1);
  await until(() => f.store.get('agent', first.agentId).status === 'disconnected', 'idle session reaped');
  await until(() => f.coordinator.sessions.size === 0, 'session released');
  assert.equal(f.instances[0].closed, true); assert.equal(f.store.get('agent', first.agentId).error, null);
  assert.equal((await f.coordinator.outcome(first.agentId)).output, 'done: quick', 'its last result is still readable');
  f.factory.mode = 'hold';
  const busy = await f.delegate({ agentId: first.agentId, prompt: 'long', waitMs: 0 });
  await until(() => f.instances[1].finish, 'turn running');
  await delay(450);
  assert.equal(f.store.get('agent', first.agentId).status, 'running', 'a running turn keeps its session');
  assert.equal(f.instances[1].closed, false);
  f.instances[1].finish({ status: 'completed', text: 'long done' });
  assert.equal((await f.coordinator.outcome(first.agentId, { deliveryId: busy.deliveryId, waitMs: 5000 })).output, 'long done');
  await until(() => f.store.get('agent', first.agentId).status === 'disconnected', 'reaped again once idle');
  f.factory.mode = 'approval';
  const blocked = await f.delegate({ agentId: first.agentId, prompt: 'needs approval', waitMs: 5000 });
  await delay(450);
  assert.equal(f.store.get('agent', first.agentId).status, 'waiting', 'a session waiting for a person is kept');
  f.coordinator.resolve('approval', { id: blocked.approvals[0].id, optionId: 'deny' });
});

test('connected sessions are capped per provider with an actionable error', async t => {
  const f = fixture(t, { providerSettings: { claude: { maxSessions: 2, sessionIdleMs: 0 } } });
  const one = await f.delegate({ provider: 'claude', prompt: 'one', waitMs: 5000 });
  await f.delegate({ provider: 'claude', prompt: 'two', waitMs: 5000 });
  const counts = () => [f.store.count('workflow', { projectId: f.project.id }), f.store.count('agent', { projectId: f.project.id })];
  const before = counts();
  await assert.rejects(f.delegate({ provider: 'claude', prompt: 'three', waitMs: 5000 }), error => {
    assert.equal(error.code, 'agent_limit'); assert.match(error.message, /2 claude sessions are already connected/);
    assert.match(error.message, /agents\.stop/); assert.match(error.message, /providers\.configure \{provider:"claude", settings:\{maxSessions:/); return true;
  });
  assert.deepEqual(counts(), before, 'a refused session leaves no workflow or agent behind');
  assert.equal((await f.delegate({ provider: 'codex', prompt: 'other provider', waitMs: 5000 })).settled, true);
  await f.coordinator.stop(one.agentId);
  assert.equal((await f.delegate({ provider: 'claude', prompt: 'three', waitMs: 5000 })).output, 'done: three');
  assert.throws(() => f.coordinator.resume(one.agentId), { code: 'agent_limit' });
});

test('completing a workflow stops its sessions', async t => {
  const f = fixture(t);
  const first = await f.delegate({ provider: 'codex', prompt: 'one', waitMs: 5000 });
  const other = await f.delegate({ provider: 'codex', prompt: 'two', waitMs: 5000 });
  f.store.update('workflow', first.workflowId, { status: 'completed' });
  await until(() => f.store.get('agent', first.agentId).status === 'closed', 'session of the completed workflow stopped');
  assert.equal(f.instances[0].closed, true); assert.equal(f.coordinator.sessions.has(first.agentId), false);
  assert.equal(f.store.get('agent', other.agentId).status, 'ready'); assert.equal(f.instances[1].closed, false);
  await assert.rejects(f.delegate({ agentId: first.agentId, prompt: 'more' }), { code: 'workflow_inactive' });
});

test('a turn is cancelled at its time limit and reported as timed out', async t => {
  const f = fixture(t, { providerSettings: { codex: { turnTimeoutMs: 150, turnIdleTimeoutMs: 0 } }, cancelGraceMs: 150 });
  f.factory.mode = 'hold';
  const timedOut = await f.delegate({ provider: 'codex', prompt: 'never ends', waitMs: 5000 });
  assert.equal(timedOut.settled, true); assert.equal(timedOut.turn.status, 'failed'); assert.equal(timedOut.turn.error.code, 'turn_timeout');
  assert.match(timedOut.error.message, /providers\.codex\.turnTimeoutMs/);
  assert.equal(f.instances[0].cancels, 1); assert.equal(timedOut.status, 'ready', 'a confirmed interruption keeps the session');
  assert.equal(f.store.get('delivery', timedOut.deliveryId).status, 'failed');
  // A provider that does not confirm the interruption loses its process.
  f.instances[0].ignoreCancel = true;
  const stuck = await f.delegate({ agentId: timedOut.agentId, prompt: 'ignores cancel', waitMs: 5000 });
  assert.equal(stuck.settled, true); assert.equal(stuck.turn.status, 'failed'); assert.equal(stuck.turn.error.code, 'turn_timeout');
  assert.equal(stuck.status, 'disconnected'); assert.equal(f.instances[0].cancels, 2);
  await until(() => f.instances[0].closed && !f.coordinator.sessions.has(timedOut.agentId), 'process ended');
  f.factory.mode = 'complete';
  assert.equal((await f.delegate({ agentId: timedOut.agentId, prompt: 'again', waitMs: 5000 })).output, 'done: again');
});

test('the idle watchdog follows native progress, and time spent waiting for a person counts for neither limit', async t => {
  const f = fixture(t, { providerSettings: { codex: { turnTimeoutMs: 60000, turnIdleTimeoutMs: 250 }, claude: { turnTimeoutMs: 200, turnIdleTimeoutMs: 100 } } });
  f.factory.mode = 'hold';
  const working = await f.delegate({ provider: 'codex', prompt: 'slow but alive', waitMs: 0 });
  await until(() => f.instances[0].finish, 'turn running');
  for (let i = 0; i < 12; i++) { f.instances[0].options.onEvent({ type: 'tool', nativeMethod: 'item/commandExecution/outputDelta', itemId: 'c1', text: '.', delta: true }); await delay(50); }
  assert.equal(f.store.get('agent', working.agentId).status, 'running', 'progress keeps the turn alive');
  const stalled = await f.coordinator.outcome(working.agentId, { deliveryId: working.deliveryId, waitMs: 5000 });
  assert.equal(stalled.turn.status, 'failed'); assert.equal(stalled.turn.error.code, 'turn_stalled'); assert.equal(f.instances[0].cancels, 1);
  f.factory.mode = 'approval';
  const blocked = await f.delegate({ provider: 'claude', prompt: 'needs a person', waitMs: 5000 });
  await delay(600);
  assert.equal(f.store.get('agent', blocked.agentId).status, 'waiting'); assert.equal(f.instances[1].cancels, 0);
  f.coordinator.resolve('approval', { id: blocked.approvals[0].id, optionId: 'allow' });
  assert.equal((await f.coordinator.outcome(blocked.agentId, { jobId: blocked.jobId, waitMs: 5000 })).turn.status, 'completed');
});

test('a provider with one process per turn gets a channel token per turn, valid only while that process runs', async t => {
  const f = fixture(t);
  f.factory.mode = 'hold'; f.factory.capabilities = { process: 'per-turn' };
  const running = await f.delegate({ provider: 'claude', prompt: 'turn one', waitMs: 0 });
  const agent = f.instances[0];
  await until(() => agent.finish, 'turn running');
  const initial = f.tokenOf(agent), first = agent.channel.env.DEVMATE_AGENT_TOKEN;
  assert.notEqual(first, initial);
  assert.throws(() => f.coordinator.channelCall(initial, 'agent_peers', {}), { code: 'unauthorized' }, 'the token issued before any process existed is dead');
  assert.equal(f.coordinator.channelCall(first, 'agent_peers', {}).items.length, 1);
  agent.finish({ status: 'completed', text: 'one' });
  await f.coordinator.outcome(running.agentId, { deliveryId: running.deliveryId, waitMs: 5000 });
  await until(() => !f.coordinator.sessions.get(running.agentId).draining, 'turn finished');
  assert.throws(() => f.coordinator.channelCall(first, 'agent_peers', {}), { code: 'unauthorized' }, 'between turns there is no process and no valid token');
  assert.equal(f.coordinator.tokens.size, 0);
  await f.delegate({ agentId: running.agentId, prompt: 'turn two', waitMs: 0 });
  await until(() => agent.prompts.length === 2, 'second turn running');
  const second = agent.channel.env.DEVMATE_AGENT_TOKEN;
  assert.notEqual(second, first); assert.equal(f.coordinator.channelCall(second, 'agent_peers', {}).items.length, 1);
  agent.finish({ status: 'completed', text: 'two' });
});

test('sessions started by a principal are stopped when that principal loses access', async t => {
  const f = fixture(t);
  const mine = await f.delegate({ provider: 'codex', prompt: 'member task', waitMs: 5000, caller: 'member-1' }, { kind: 'user', id: 'member-1', label: 'member-1' });
  const implied = await f.delegate({ provider: 'claude', prompt: 'no explicit caller', waitMs: 5000 }, { kind: 'user', id: 'member-1', label: 'member-1' });
  const theirs = await f.delegate({ provider: 'codex', prompt: 'other member', waitMs: 5000, caller: 'member-2' });
  assert.equal(f.store.get('agent', implied.agentId).caller, 'member-1');
  const result = await f.coordinator.stopForCaller('member-1');
  assert.deepEqual(result, { callerId: 'member-1', agentIds: [mine.agentId, implied.agentId] });
  assert.equal(f.store.get('agent', mine.agentId).status, 'closed'); assert.equal(f.store.get('agent', implied.agentId).status, 'closed');
  assert.equal(f.store.get('agent', theirs.agentId).status, 'ready'); assert.equal(f.instances[2].closed, false);
  // Whoever continues an agent becomes responsible for its new session.
  await f.delegate({ agentId: mine.agentId, prompt: 'continued', waitMs: 5000, caller: 'member-2' });
  assert.equal(f.store.get('agent', mine.agentId).caller, 'member-2');
  assert.deepEqual((await f.coordinator.stopForCaller('member-1')).agentIds, []);
});

test('a retried native error is not the agent\'s error, and a completed turn clears one', async t => {
  const f = fixture(t); f.factory.mode = 'hold';
  const running = await f.delegate({ provider: 'codex', prompt: 'flaky network', waitMs: 0 });
  const agent = f.instances[0];
  await until(() => agent.finish, 'turn running');
  agent.options.onEvent({ type: 'error', willRetry: true, message: 'stream disconnected, retrying 1/5', nativeMethod: 'error' });
  assert.equal(f.store.get('agent', running.agentId).error, null);
  agent.options.onEvent({ type: 'error', willRetry: false, message: 'model overloaded', nativeMethod: 'error' });
  assert.deepEqual(f.store.get('agent', running.agentId).error, { code: 'native_error', message: 'model overloaded' });
  agent.finish({ status: 'completed', text: 'recovered' });
  const done = await f.coordinator.outcome(running.agentId, { deliveryId: running.deliveryId, waitMs: 5000 });
  assert.equal(done.output, 'recovered'); assert.equal(done.error, undefined);
  assert.equal(f.store.get('agent', running.agentId).error, null);
});

test('providers reports installed versions from --version without any agent turn', async t => {
  const reports = version => ({ file: process.execPath, args: ['-e', 'console.log(' + JSON.stringify(version) + ')', '--'] });
  const f = fixture(t, { providerSettings: { codex: { command: reports('codex-cli 0.161.0') }, claude: { command: reports('2.1.100 (Claude Code)') },
    gemini: { command: { file: path.join(os.tmpdir(), 'devmate-no-such-agent.exe'), args: [] } }, grok: { command: reports('grok 1.2.3') } } });
  const { items } = await f.coordinator.providers();
  assert.deepEqual(items.map(item => [item.provider, item.status, item.version]),
    [['codex', 'installed', '0.161.0'], ['claude', 'unsupported', '2.1.100'], ['gemini', 'unavailable', null], ['grok', 'installed', '1.2.3']]);
  assert.equal(items[1].minimumVersion, '2.1.200'); assert.equal(items[1].error.code, 'unsupported_version');
  assert.equal(f.instances.length, 0);
});
