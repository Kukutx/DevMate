import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult, serverInstructions } from '../runtime/mcp.mjs';
import { main } from '../runtime/cli.mjs';

// What a coding agent does is spent on the owner's account with its provider. A task that a connected client hands
// over therefore waits for the owner's word at the computer, unless the owner chose otherwise there.
const local = Object.freeze({ id: 'owner', surface: 'local' });
const connected = Object.freeze({ id: 'owner' });

// A stand-in for a provider: every text it is sent is a turn that would have been paid for.
function adapters() {
  const instances = [];
  const factory = options => {
    const instance = { options, sent: [], capabilities: { steer: false, approvals: true, mcp: true },
      async start() { return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
      async send({ text }) { instance.sent.push(text); await factory.during?.(instance, text); return { status: 'completed', text: 'done: ' + text, native: {} }; },
      async cancel() { return { requested: false }; },
      async close() {}
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}

async function fixture(t) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-delegation-')));
  const { factory, instances } = adapters();
  let service;
  // The same instance directory, as after a restart of the runtime.
  const open = async () => {
    await service?.close();
    service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: factory });
    return service.ready;
  };
  await open();
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const root = path.join(temp, 'project'); fs.mkdirSync(root);
  const project = await service.call('project.create', { root, name: 'Shop' }, local);
  return { service, project, factory, instances, restart: open };
}
const until = async (ready, what) => {
  for (let round = 0; round < 400; round++) { if (await ready()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  assert.fail('timed out waiting for ' + what);
};
const said = (service, name, result) => presentResult(service.operations.get(name), result).content[0].text;
const offered = (service, context) => service.visibleOperations(context).map(operation => operation.name);
const turns = instances => instances.flatMap(instance => instance.sent);

test('a task that a connected client hands to an agent waits for the owner\'s word at the computer; what the owner sends there does not', async t => {
  const { service, project, instances } = await fixture(t);
  assert.deepEqual([await service.call('delegation.read', {}, connected), await service.call('delegation.read', {}, local)], [{ mode: 'ask' }, { mode: 'ask' }]);
  const started = Date.now();
  const waiting = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Fix the checkout\nand say what you changed', waitMs: 20000 }, connected);
  // The client is answered at once, and is told what to tell its user. Nothing was sent to the provider.
  assert.ok(Date.now() - started < 5000, 'the client did not wait out its time');
  assert.deepEqual([waiting.status, waiting.settled, waiting.approvals.length, waiting.approvals[0].delegation], ['waiting', false, 1, true]);
  assert.deepEqual(turns(instances), []);
  const text = said(service, 'agents.delegate', waiting);
  assert.match(text, /^\[no result yet\]\n\[agent waiting; nothing has run yet: the owner has to allow this task at their computer first, because it runs on their account with codex\. Ask them to answer it in the DevMate workbench there \(devmate ui\) or in their editor; /);
  assert.match(text, /devmate delegation allow, run there, ends the asking\. Then call agents_result agentId:\S+ deliveryId:\S+ to wait for this task\]\n/);
  // What the owner is shown: which agent, which project, the task, and that it is their account.
  const asked = service.store.get('approval', waiting.approvals[0].id);
  assert.deepEqual([asked.kind, asked.status, asked.summary, asked.options.map(option => option.optionId)],
    ['delegation', 'pending', 'Run a task with codex in Shop: Fix the checkout', ['allow_once', 'allow_agent', 'deny']]);
  assert.deepEqual([asked.details.agent, asked.details.project, asked.details.askedBy, asked.details.task], ['codex', 'Shop', 'a connected client', 'Fix the checkout\nand say what you changed']);
  assert.match(asked.details.note, /uses your account with codex/);

  // The client that asked is not the one to answer: not in the guarded profile, and not with full access either,
  // which hands a client what the owner decides about this computer. Nor does choosing full access answer it.
  const answer = { id: asked.id, optionId: 'allow_once' };
  await assert.rejects(service.call('approval.resolve', answer, connected), { code: 'forbidden', message: /user's own/ });
  await service.call('access.update', { profile: 'full' }, local);
  assert.equal(service.store.get('approval', asked.id).status, 'pending', 'full access does not grant it');
  await assert.rejects(service.call('approval.resolve', answer, connected), { code: 'forbidden', message: /the owner's to say at their own computer, in either access profile/ });
  await assert.rejects(service.call('operations.call', { operation: 'approval.resolve', input: answer }, connected), { code: 'forbidden' });
  assert.doesNotMatch(said(service, 'agents.result', await service.call('agents.result', { agentId: waiting.agentId }, connected)), /operations_call \(approval\.resolve/);
  assert.deepEqual(turns(instances), []);

  // The owner, at the computer, allows this one task. It runs, and the client that waited gets its result.
  await service.call('approval.resolve', answer, local);
  const first = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected);
  assert.deepEqual([first.settled, first.output, first.approvals], [true, 'done: Fix the checkout\nand say what you changed', []]);
  // One task was allowed, not the agent: the next one is asked about again. This time the owner allows the agent.
  const second = await service.call('agents.delegate', { agentId: waiting.agentId, prompt: 'Now the tests', waitMs: 20000 }, connected);
  assert.deepEqual([second.status, second.approvals.length, turns(instances).length], ['waiting', 1, 1]);
  await service.call('approval.resolve', { id: second.approvals[0].id, optionId: 'allow_agent' }, local);
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: second.deliveryId, waitMs: 5000 }, connected)).output, 'done: Now the tests');
  const third = await service.call('agents.delegate', { agentId: waiting.agentId, prompt: 'And the docs', waitMs: 20000 }, connected);
  assert.deepEqual([third.settled, third.output, third.approvals], [true, 'done: And the docs', []]);
  // That was said of this agent. Another one the client starts is asked about.
  const other = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Review it', waitMs: 20000 }, connected);
  assert.deepEqual([other.status, other.approvals.length], ['waiting', 1]);
  await service.call('approval.resolve', { id: other.approvals[0].id, optionId: 'deny' }, local);

  // What the owner hands over at the computer is theirs: nothing is asked.
  const own = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'My own task', waitMs: 20000 }, local);
  assert.deepEqual([own.settled, own.output, own.approvals], [true, 'done: My own task', []]);
  assert.deepEqual(turns(instances), ['Fix the checkout\nand say what you changed', 'Now the tests', 'And the docs', 'My own task']);
  assert.deepEqual((await service.call('approval.list', { projectId: project.id }, local)).items.map(item => [item.kind, item.status, item.answer?.optionId]),
    [['delegation', 'resolved', 'allow_once'], ['delegation', 'resolved', 'allow_agent'], ['delegation', 'resolved', 'deny']]);
});

test('a task the owner does not allow is not run and says so; one the client takes back is no longer asked about', async t => {
  const { service, project, instances } = await fixture(t);
  const waiting = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Rewrite everything', waitMs: 20000 }, connected);
  await service.call('approval.resolve', { id: waiting.approvals[0].id, optionId: 'deny' }, local);
  const declined = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected);
  assert.deepEqual([declined.settled, declined.status, declined.error, declined.approvals], [true, 'ready', { code: 'delegation_declined', message: 'The owner did not allow this task.' }, []]);
  assert.match(said(service, 'agents.result', declined), /^\[The owner did not allow this task\.\]/);
  // Nothing was spent: no turn at the provider, and none counted against the workflow.
  assert.deepEqual(turns(instances), []);
  assert.equal(service.store.get('workflow', waiting.workflowId).usedTurns, 0);
  assert.equal((await service.call('job.list', { projectId: project.id }, local)).items.length, 0);

  // The client gives up on a task that still waits: the question to the owner goes with it.
  const again = await service.call('agents.delegate', { agentId: waiting.agentId, prompt: 'Rewrite half of it', waitMs: 20000 }, connected);
  assert.equal(again.approvals.length, 1);
  assert.deepEqual(await service.call('agents.cancel', { id: waiting.agentId }, connected), { id: waiting.agentId, requested: true });
  assert.equal(service.store.get('approval', again.approvals[0].id).status, 'expired');
  const withdrawn = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: again.deliveryId }, connected);
  assert.deepEqual([withdrawn.settled, withdrawn.status, withdrawn.approvals], [true, 'ready', []]);
  await assert.rejects(service.call('approval.resolve', { id: again.approvals[0].id, optionId: 'allow_once' }, local), { code: 'request_expired' });
  // The agent is free for what the owner sends it, and an agent that is stopped takes its question with it.
  assert.equal((await service.call('agents.delegate', { agentId: waiting.agentId, prompt: 'Mine', waitMs: 20000 }, local)).output, 'done: Mine');
  const last = await service.call('agents.delegate', { agentId: waiting.agentId, prompt: 'One more', waitMs: 20000 }, connected);
  await service.call('agents.stop', { id: waiting.agentId }, local);
  assert.equal(service.store.get('approval', last.approvals[0].id).status, 'expired');
  assert.equal(service.store.get('delivery', last.deliveryId).status, 'cancelled');
  assert.deepEqual(turns(instances), ['Mine']);
});

test('the owner chooses at the computer whether to be asked: allow runs the tasks, off refuses them, and both outlast a restart', async t => {
  const { service, project, instances, restart } = await fixture(t);
  // The choice is the owner's, at the computer: a connected client can read it, in either access profile.
  await service.call('access.update', { profile: 'full' }, local);
  await assert.rejects(service.call('delegation.update', { mode: 'allow' }, connected), { code: 'forbidden', message: /local control interface/ });
  await assert.rejects(service.call('operations.call', { operation: 'delegation.update', input: { mode: 'allow' } }, connected), { code: 'unknown_operation' });
  await assert.rejects(service.call('delegation.update', { mode: 'sometimes' }, local), { code: 'invalid_input' });
  assert.equal(offered(service, connected).includes('delegation.update'), false); assert.equal(offered(service, connected).includes('delegation.read'), true);
  await service.call('access.update', { profile: 'guarded' }, local);

  // A task that already waits is covered by "do not ask", and says that nobody answered it by hand.
  const waiting = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'First', waitMs: 20000 }, connected);
  assert.equal(waiting.approvals.length, 1);
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow' });
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected)).output, 'done: First');
  const record = service.store.get('approval', waiting.approvals[0].id);
  assert.deepEqual([record.status, record.automatic, record.answer.optionId], ['resolved', true, 'allow_once']);
  // From then on a client's task runs as it did before there was a question.
  const direct = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Second', waitMs: 20000 }, connected);
  assert.deepEqual([direct.settled, direct.output, direct.approvals], [true, 'done: Second', []]);
  const check = async current => (await current.call('runtime.doctor', {}, local)).checks.find(item => item.id === 'delegation');
  assert.deepEqual([(await check(service)).status, (await check(service)).fix], ['info', 'To be asked for each task first: devmate delegation ask']);

  // The choice is the instance's own: it is there after a restart.
  let again = await restart();
  assert.deepEqual(await again.call('delegation.read', {}, connected), { mode: 'allow' });
  const local2 = await again.call('agents.start', { projectId: project.id, workflowId: direct.workflowId, provider: 'codex' }, local);
  await until(() => again.store.get('agent', local2.id).status === 'ready', 'the agent the owner started');

  // Off: a connected client is refused before anything is made for its task, by every way a task reaches an agent,
  // and is not offered those ways. The owner at the computer is not affected.
  await again.call('delegation.update', { mode: 'off' }, local);
  const before = { workflows: again.store.count('workflow', { projectId: project.id }), agents: again.store.count('agent', { projectId: project.id }), sent: turns(instances).length };
  const refused = { code: 'delegation_off', message: /The owner does not let connected clients hand tasks to the coding agents on this computer\..*devmate delegation ask/ };
  await assert.rejects(again.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Third', waitMs: 1000 }, connected), refused);
  await assert.rejects(again.call('agents.delegate', { agentId: local2.id, prompt: 'Third', waitMs: 1000 }, connected), refused);
  await assert.rejects(again.call('agents.start', { projectId: project.id, workflowId: direct.workflowId, provider: 'codex' }, connected), refused);
  await assert.rejects(again.call('agents.send', { id: local2.id, body: 'Third' }, connected), refused);
  await assert.rejects(again.call('message.send', { projectId: project.id, workflowId: direct.workflowId, recipientIds: [local2.id], body: 'Third' }, connected), refused);
  await assert.rejects(again.call('task.create', { projectId: project.id, workflowId: direct.workflowId, title: 'Third', instruction: 'Third', assigneeId: local2.id }, connected), refused);
  assert.deepEqual({ workflows: again.store.count('workflow', { projectId: project.id }), agents: again.store.count('agent', { projectId: project.id }), sent: turns(instances).length }, before);
  assert.equal(again.store.count('task', { projectId: project.id }), 0, 'a task that could not be handed over was not made either');
  for (const name of ['agents.delegate', 'agents.start', 'agents.send', 'message.send']) {
    assert.equal(offered(again, connected).includes(name), false, name); assert.equal(offered(again, local).includes(name), true, name);
  }
  assert.equal((await again.call('operations.list', {}, connected)).items.some(item => item.name === 'agents.delegate'), false);
  assert.doesNotMatch(serverInstructions(again), /agents_delegate/);
  assert.deepEqual([(await check(again)).status, (await check(again)).detail], ['ok', 'A connected client cannot hand tasks to the coding agents here.']);
  assert.equal((await again.call('agents.delegate', { agentId: local2.id, prompt: 'The owner still can', waitMs: 20000 }, local)).output, 'done: The owner still can');

  // Back to being asked. What waits when the runtime stops is not carried over: nothing runs unasked after a restart.
  await again.call('delegation.update', { mode: 'ask' }, local);
  assert.match(serverInstructions(again), /agents_delegate hands a whole task/);
  assert.match((await check(again)).detail, /waits until you allow it at this computer, in either access profile\.$/);
  const held = await again.call('agents.delegate', { agentId: local2.id, prompt: 'Fourth', waitMs: 20000 }, connected);
  assert.equal(held.approvals.length, 1);
  again = await restart();
  assert.deepEqual(await again.call('delegation.read', {}, local), { mode: 'ask' });
  assert.deepEqual([again.store.get('approval', held.approvals[0].id).status, again.store.get('delivery', held.deliveryId).status], ['expired', 'cancelled']);
  assert.ok(!turns(instances).includes('Fourth'));
});

test('every way a task reaches an agent is asked about, also when an agent that works for a client passes work on', async t => {
  const { service, project, factory, instances } = await fixture(t);
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Two agents' }, local);
  const scope = { projectId: project.id, workflowId: workflow.id };
  // Two agents the owner started at the computer. Starting one spends nothing and is not asked about.
  const first = await service.call('agents.start', { ...scope, provider: 'codex', name: 'Builder' }, local);
  const second = await service.call('agents.start', { ...scope, provider: 'claude', name: 'Reviewer' }, local);
  await until(() => [first, second].every(agent => service.store.get('agent', agent.id).status === 'ready'), 'both agents');
  const pending = async () => (await service.call('approval.list', { ...scope, status: 'pending' }, local)).items;
  const allow = async what => { await until(async () => (await pending()).length === 1, what); const [item] = await pending(); await service.call('approval.resolve', { id: item.id, optionId: 'allow_once' }, local); return item; };

  // A message and an assigned task from the client: each is a turn, and each waits.
  const message = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Build it' }, connected);
  assert.equal((await allow('the message to be asked about')).summary, 'Run a task with Builder in Shop: Build it');
  await until(() => service.store.get('message', message.id).status === 'delivered', 'the message to be run');
  const task = await service.call('task.create', { ...scope, title: 'Review', instruction: 'Review it', assigneeId: second.id }, connected);
  assert.deepEqual(turns(instances), ['Build it']);
  await allow('the task to be asked about');
  await until(() => service.store.get('task', task.id).status === 'completed', 'the task to be run');
  // The same from the owner at the computer run at once.
  const own = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Build it my way' }, local);
  await until(() => service.store.get('message', own.id).status === 'delivered', 'the owner\'s message');
  assert.deepEqual(await pending(), []);

  // An agent writes to another while it works. What it writes on a task of the client is the client's, and is asked
  // about; what it writes on a task of the owner is the owner's.
  const token = instance => instance.options.mcpServers.find(item => item.name === 'devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const builder = instances.find(instance => instance.sent.includes('Build it'));
  let passed = 0;
  factory.during = async (instance, text) => {
    if (instance === builder && text.startsWith('Pass it on'))
      service.agents.channelCall(token(instance), 'agent_send_message', { operationId: 'pass-' + ++passed, recipientIds: [second.id], body: 'From the builder: ' + text });
  };
  await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Pass it on for the client' }, connected);
  await allow('the client\'s message to the builder');
  const relayed = await allow('what the builder passed on for the client');
  assert.deepEqual([relayed.agentId, relayed.details.askedBy], [second.id, 'the agent Builder, which works for a connected client']);
  await until(() => turns(instances).includes('Message from Builder (' + first.id + '). Use the DevMate agent_send_message tool to reply when needed.\n\nFrom the builder: Pass it on for the client'), 'the reviewer to be given it');
  const mine = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Pass it on for me' }, local);
  await until(() => turns(instances).some(text => text.endsWith('From the builder: Pass it on for me')), 'the reviewer to be given the owner\'s');
  await until(() => service.store.get('message', mine.id).status === 'delivered', 'the owner\'s message');
  assert.deepEqual(await pending(), [], 'nothing of the owner\'s own was asked about');
});

test('devmate delegation shows and changes the choice', async () => {
  const output = () => { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; };
  let mode = 'ask';
  const calls = [];
  const clientFactory = () => ({ call: async (name, input) => { calls.push([name, input]); if (name === 'delegation.update') mode = input.mode; return { mode }; } });
  const run = async args => { const stdout = output(), stderr = output(); return { code: await main(args, { stdout, stderr, clientFactory }), stdout: stdout.text, stderr: stderr.text }; };
  const shown = await run(['delegation']);
  assert.deepEqual([shown.stdout, calls.at(-1)], ['ask\n', ['delegation.read', {}]]); assert.match(shown.stderr, /waits until you allow it at this computer.*devmate delegation allow/);
  const allowed = await run(['delegation', 'allow']);
  assert.deepEqual([allowed.code, allowed.stdout, calls.at(-1)], [0, 'allow\n', ['delegation.update', { mode: 'allow' }]]); assert.match(allowed.stderr, /on your account with the provider\. To be asked first: devmate delegation ask/);
  assert.match((await run(['delegation', 'off'])).stderr, /cannot hand tasks to the coding agents here; you still can, at this computer/);
  const wrong = await run(['delegation', 'never']);
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /delegation ask, delegation allow or delegation off/);
});
