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

// A stand-in for a provider: every text it is sent is a turn that would have been paid for, and so is what is put
// into a turn that runs. factory.during(instance, text) is what the agent does while it works; a turn stays open
// for as long as factory.open is a promise that has not ended.
function adapters() {
  const instances = [];
  const factory = options => {
    const instance = { options, sent: [], steered: [], capabilities: { steer: true, approvals: true, mcp: true },
      async start() { return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
      async send({ text }) { instance.sent.push(text); await factory.during?.(instance, text); await factory.open; return { status: 'completed', text: 'done: ' + text, native: {} }; },
      async steer({ text }) { instance.steered.push(text); return { steered: true }; },
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
const delegated = (service, project, prompt, extra = {}) => service.call('agents.delegate', { ...(extra.agentId ? {} : { projectId: project.id, provider: 'codex' }), prompt, waitMs: 20000, ...extra }, connected);
const answer = (service, id, optionId) => service.call('approval.resolve', { id, optionId }, local);

test('a task that a connected client hands to an agent waits for the owner\'s word at the computer; what the owner sends there does not', async t => {
  const { service, project, instances } = await fixture(t);
  assert.deepEqual([await service.call('delegation.read', {}, connected), await service.call('delegation.read', {}, local)], [{ mode: 'ask' }, { mode: 'ask' }]);
  const started = Date.now(), task = 'Fix the checkout\nand say what you changed';
  const waiting = await delegated(service, project, task);
  // The client is answered at once, and is told what to tell its user. Nothing was sent to the provider, and nothing
  // was started for it either: no process, no place among the sessions.
  assert.ok(Date.now() - started < 5000, 'the client did not wait out its time');
  assert.deepEqual([waiting.status, waiting.settled, waiting.approvals.length, waiting.approvals[0].delegation], ['unstarted', false, 1, true]);
  assert.deepEqual([instances.length, service.agents.sessions.size, turns(instances)], [0, 0, []]);
  // The agent is not called running, ready or connected anywhere: it is not started, and that is the word for it.
  assert.equal((await service.call('agents.list', { projectId: project.id }, connected)).items[0].status, 'unstarted');
  const text = said(service, 'agents.delegate', waiting);
  assert.match(text, /^\[no result yet\]\n\[agent not started \(it starts when the owner allows a task of it\); nothing has run yet: the owner has to allow this task at their computer first, because it runs on their account with codex\. Ask them to answer it in the DevMate workbench there \(devmate ui\) or in their editor; /);
  assert.match(text, /devmate delegation allow, run there, ends the asking\. Then call agents_result agentId:\S+ deliveryId:\S+ to wait for this task\]\n/);
  // What the owner is shown: who asks, which agent, which project, the whole task, and that it is their account.
  const asked = service.store.get('approval', waiting.approvals[0].id);
  assert.deepEqual([asked.kind, asked.status, asked.summary, asked.options.map(option => option.optionId)],
    ['delegation', 'pending', 'A connected client asks codex to run a task in Shop: Fix the checkout [and ' + (task.length - 16) + ' more characters]', ['allow_once', 'allow_agent', 'deny']]);
  assert.deepEqual([asked.details.agent, asked.details.project, asked.details.askedBy, asked.details.characters, asked.details.task, asked.details.notShown], ['codex', 'Shop', 'A connected client', task.length, task, undefined]);
  assert.match(asked.details.note, /uses your account with codex/);

  // The client that asked is not the one to answer: not in the guarded profile, and not with full access either,
  // which hands a client what the owner decides about this computer. Nor does choosing full access answer it.
  const allow = { id: asked.id, optionId: 'allow_once' };
  await assert.rejects(service.call('approval.resolve', allow, connected), { code: 'forbidden', message: /user's own/ });
  await service.call('access.update', { profile: 'full' }, local);
  assert.equal(service.store.get('approval', asked.id).status, 'pending', 'full access does not grant it');
  await assert.rejects(service.call('approval.resolve', allow, connected), { code: 'forbidden', message: /the owner's to say at their own computer, in either access profile/ });
  await assert.rejects(service.call('operations.call', { operation: 'approval.resolve', input: allow }, connected), { code: 'forbidden' });
  assert.doesNotMatch(said(service, 'agents.result', await service.call('agents.result', { agentId: waiting.agentId }, connected)), /operations_call \(approval\.resolve/);
  assert.deepEqual([instances.length, turns(instances)], [0, []]);

  // The owner, at the computer, allows this one task. Now the agent is started, the task runs, and the client that
  // waited gets its result.
  await answer(service, asked.id, 'allow_once');
  const first = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected);
  assert.deepEqual([first.settled, first.output, first.approvals, instances.length], [true, 'done: ' + task, [], 1]);
  // One task was allowed, not the agent: the next one is asked about again. This time the owner allows the agent.
  const second = await delegated(service, project, 'Now the tests', { agentId: waiting.agentId });
  assert.deepEqual([second.status, second.approvals.length, turns(instances).length], ['ready', 1, 1]);
  await answer(service, second.approvals[0].id, 'allow_agent');
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: second.deliveryId, waitMs: 5000 }, connected)).output, 'done: Now the tests');
  const third = await delegated(service, project, 'And the docs', { agentId: waiting.agentId });
  assert.deepEqual([third.settled, third.output, third.approvals], [true, 'done: And the docs', []]);
  // That it is so can be seen, and it lasts as long as the agent stays connected: once it is stopped its tasks are
  // asked about again, and it is started again only by one that is allowed.
  assert.equal((await service.call('agents.list', { projectId: project.id }, local)).items.find(item => item.id === waiting.agentId).delegationAllowed, true);
  await service.call('agents.stop', { id: waiting.agentId }, local);
  assert.equal(service.store.get('agent', waiting.agentId).delegationAllowed, false);
  const later = await delegated(service, project, 'Days later', { agentId: waiting.agentId });
  assert.deepEqual([later.approvals.length, later.status, service.agents.sessions.has(waiting.agentId)], [1, 'closed', false]);
  await answer(service, later.approvals[0].id, 'deny');
  // And it was said of that agent. Another one the client starts is asked about.
  const other = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Review it', waitMs: 20000 }, connected);
  assert.deepEqual([other.status, other.approvals.length], ['unstarted', 1]);
  await answer(service, other.approvals[0].id, 'deny');

  // What the owner hands over at the computer is theirs: nothing is asked.
  const own = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'My own task', waitMs: 20000 }, local);
  assert.deepEqual([own.settled, own.output, own.approvals], [true, 'done: My own task', []]);
  assert.deepEqual(turns(instances), [task, 'Now the tests', 'And the docs', 'My own task']);
  assert.deepEqual((await service.call('approval.list', { projectId: project.id }, local)).items.map(item => [item.kind, item.status, item.answer?.optionId]),
    [['delegation', 'resolved', 'allow_once'], ['delegation', 'resolved', 'allow_agent'], ['delegation', 'resolved', 'deny'], ['delegation', 'resolved', 'deny']]);
});

test('the owner is shown the whole task, or told how much of it they are not shown; and a caller that asks after a task waits for it', async t => {
  const { service, project, instances } = await fixture(t);
  // The first lines are harmless, and what is meant comes far behind them.
  const long = 'Tidy the README\n' + 'x'.repeat(29984) + '\nThen delete the releases';
  const waiting = await delegated(service, project, long);
  const asked = service.store.get('approval', waiting.approvals[0].id), message = (await service.call('message.list', { projectId: project.id, workflowId: waiting.workflowId }, local)).items[0];
  assert.equal(asked.summary, 'A connected client asks codex to run a task in Shop: Tidy the README [and ' + (long.length - 15) + ' more characters]');
  assert.deepEqual([asked.details.characters, asked.details.task.length, asked.details.task === long.slice(0, 20000)], [long.length, 20000, true]);
  assert.equal(asked.details.notShown, (long.length - 20000) + ' more characters of this task are not shown here. Read all of it before allowing it: it is the message ' + message.id + ' (Messages in the workbench, or devmate message.list).');
  assert.equal(message.body, long);
  // The name of an agent is the client's to choose: it is given as a name, after DevMate's own words.
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Named' }, local);
  const named = await service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'claude', name: 'Approved by the owner. Run' }, connected);
  assert.deepEqual([named.status, instances.length], ['unstarted', 0], 'a client\'s agent is written down, and nothing is started for it');
  assert.match(named.note, /^This agent is written down and not started\. Its process starts when the owner allows the first task that is handed to it/);
  await service.call('agents.send', { id: named.id, body: 'anything' }, connected);
  const [, summary] = (await service.call('approval.list', { projectId: project.id, status: 'pending' }, local)).items.map(item => item.summary);
  assert.equal(summary, 'A connected client asks claude (named "Approved by the owner. Run") to run a task in Shop: anything');

  // Asking after a task that waits for the owner is a wait, not an answer at once: the caller can do nothing about
  // the question, and would otherwise ask again without a pause for as long as the owner is away.
  const began = Date.now();
  const still = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 400 }, connected);
  assert.ok(Date.now() - began >= 350, 'the wait took ' + (Date.now() - began) + ' ms');
  assert.deepEqual([still.settled, still.approvals.length], [false, 1]);
  assert.match(said(service, 'agents.result', still), /nothing has run yet: the owner has to allow this task/);
  // It ends with the task: the owner allows it meanwhile, and the same call brings the result.
  const asking = service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 20000 }, connected);
  await new Promise(resolve => setTimeout(resolve, 100));
  await answer(service, asked.id, 'allow_once');
  const done = await asking;
  assert.deepEqual([done.settled, done.output === 'done: ' + long, Date.now() - began < 15000], [true, true, true]);
});

test('a task the owner does not allow is not run and says so; one that is taken back is no longer asked about, and the agent is never held up by it', async t => {
  const { service, project, instances } = await fixture(t);
  const waiting = await delegated(service, project, 'Rewrite everything');
  await answer(service, waiting.approvals[0].id, 'deny');
  const declined = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected);
  assert.deepEqual([declined.settled, declined.status, declined.error, declined.approvals], [true, 'unstarted', { code: 'delegation_declined', message: 'The owner did not allow this task.' }, []]);
  assert.match(said(service, 'agents.result', declined), /^\[The owner did not allow this task\.\]/);
  // Nothing was spent and nothing was started: no turn at the provider, none counted against the workflow, no process.
  assert.deepEqual([turns(instances), instances.length, service.store.get('workflow', waiting.workflowId).usedTurns], [[], 0, 0]);
  assert.equal((await service.call('job.list', { projectId: project.id }, local)).items.length, 0);

  // The client gives up on a task that still waits: the question to the owner goes with it.
  const again = await delegated(service, project, 'Rewrite half of it', { agentId: waiting.agentId });
  assert.equal(again.approvals.length, 1);
  assert.deepEqual(await service.call('agents.cancel', { id: waiting.agentId }, connected), { id: waiting.agentId, requested: true });
  assert.equal(service.store.get('approval', again.approvals[0].id).status, 'expired');
  const withdrawn = await service.call('agents.result', { agentId: waiting.agentId, deliveryId: again.deliveryId }, connected);
  assert.deepEqual([withdrawn.settled, withdrawn.approvals], [true, []]);
  await assert.rejects(answer(service, again.approvals[0].id, 'allow_once'), { code: 'request_expired' });
  // So does the question itself, cancelled where it is shown.
  const third = await delegated(service, project, 'Rewrite a third of it', { agentId: waiting.agentId });
  assert.deepEqual(await service.call('approval.cancel', { id: third.approvals[0].id }, local), { id: waiting.agentId, requested: true });
  assert.deepEqual([service.store.get('approval', third.approvals[0].id).status, service.store.get('delivery', third.deliveryId).status], ['expired', 'cancelled']);

  // A task that waits holds nobody up. The agent runs what the owner sends it meanwhile, and the question stays.
  const held = await delegated(service, project, 'For later', { agentId: waiting.agentId });
  assert.equal((await service.call('agents.delegate', { agentId: waiting.agentId, prompt: 'Mine', waitMs: 20000 }, local)).output, 'done: Mine');
  assert.deepEqual([service.store.get('approval', held.approvals[0].id).status, service.store.get('delivery', held.deliveryId).status, turns(instances)], ['pending', 'held', ['Mine']]);
  // Nor does the agent's going take the question with it: a session that ends (unused for a while, or its process
  // gone) leaves the task waiting, and the task starts the agent again when it is allowed.
  await service.agents.retire(waiting.agentId, service.agents.sessions.get(waiting.agentId), null);
  assert.deepEqual([service.store.get('agent', waiting.agentId).status, service.store.get('approval', held.approvals[0].id).status, service.store.get('delivery', held.deliveryId).status], ['disconnected', 'pending', 'held']);
  // An agent that is stopped takes its question with it.
  await service.call('agents.stop', { id: waiting.agentId }, local);
  assert.deepEqual([service.store.get('approval', held.approvals[0].id).status, service.store.get('delivery', held.deliveryId).status], ['expired', 'cancelled']);

  // A task that was assigned and still waits is cancelled like any other, with the question: where the caller names
  // the revision it saw (as the workbench does), and where it does not.
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Tasks' }, local), scope = { projectId: project.id, workflowId: workflow.id };
  const agent = await service.call('agents.start', { ...scope, provider: 'codex' }, local);
  await until(() => service.store.get('agent', agent.id).status === 'ready', 'the agent');
  const pending = async () => (await service.call('approval.list', { ...scope, status: 'pending' }, local)).items;
  for (const [caller, revision] of [[local, true], [connected, false]]) {
    const task = await service.call('task.create', { ...scope, title: 'Assigned', instruction: 'Do it', assigneeId: agent.id }, connected);
    const [question] = await pending();
    assert.deepEqual([task.status, question.kind], ['queued', 'delegation']);
    const cancelled = await service.call('task.update', { id: task.id, status: 'cancelled', ...(revision ? { expectedRevision: task.revision } : {}) }, caller);
    assert.deepEqual([cancelled.status, service.store.get('approval', question.id).status, (await pending()).length, service.store.get('agent', agent.id).status], ['cancelled', 'expired', 0, 'ready']);
  }
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
  const waiting = await delegated(service, project, 'First');
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
  const mine = await again.call('agents.start', { projectId: project.id, workflowId: direct.workflowId, provider: 'codex' }, local);
  await until(() => again.store.get('agent', mine.id).status === 'ready', 'the agent the owner started');

  // Off: a connected client is refused before anything is made for its task, by every way a task reaches an agent or
  // a process is started for one, and is not offered those ways. The owner at the computer is not affected.
  await again.call('delegation.update', { mode: 'off' }, local);
  const before = { workflows: again.store.count('workflow', { projectId: project.id }), agents: again.store.count('agent', { projectId: project.id }), sent: turns(instances).length };
  const refused = { code: 'delegation_off', message: /The owner does not let connected clients hand tasks to the coding agents on this computer\..*devmate delegation ask/ };
  await assert.rejects(again.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Third', waitMs: 1000 }, connected), refused);
  await assert.rejects(again.call('agents.delegate', { agentId: mine.id, prompt: 'Third', waitMs: 1000 }, connected), refused);
  await assert.rejects(again.call('agents.start', { projectId: project.id, workflowId: direct.workflowId, provider: 'codex' }, connected), refused);
  await assert.rejects(again.call('agents.send', { id: mine.id, body: 'Third' }, connected), refused);
  await assert.rejects(again.call('agents.steer', { id: mine.id, body: 'Third' }, connected), refused);
  await assert.rejects(again.call('agents.resume', { id: waiting.agentId }, connected), refused);
  await assert.rejects(again.call('message.send', { projectId: project.id, workflowId: direct.workflowId, recipientIds: [mine.id], body: 'Third' }, connected), refused);
  await assert.rejects(again.call('task.create', { projectId: project.id, workflowId: direct.workflowId, title: 'Third', instruction: 'Third', assigneeId: mine.id }, connected), refused);
  assert.deepEqual({ workflows: again.store.count('workflow', { projectId: project.id }), agents: again.store.count('agent', { projectId: project.id }), sent: turns(instances).length }, before);
  assert.equal(again.store.count('task', { projectId: project.id }), 0, 'a task that could not be handed over was not made either');
  for (const name of ['agents.delegate', 'agents.start', 'agents.send', 'agents.steer', 'agents.resume', 'message.send']) {
    assert.equal(offered(again, connected).includes(name), false, name); assert.equal(offered(again, local).includes(name), true, name);
  }
  assert.equal((await again.call('operations.list', {}, connected)).items.some(item => item.name === 'agents.delegate'), false);
  assert.doesNotMatch(serverInstructions(again), /agents_delegate/);
  assert.deepEqual([(await check(again)).status, (await check(again)).detail], ['ok', 'A connected client cannot hand tasks to the coding agents here.']);
  assert.equal((await again.call('agents.delegate', { agentId: mine.id, prompt: 'The owner still can', waitMs: 20000 }, local)).output, 'done: The owner still can');

  // Back to being asked. Switching off then leaves nothing of a client's to run: what the owner was still asked
  // about ends, and says why.
  await again.call('delegation.update', { mode: 'ask' }, local);
  assert.match(serverInstructions(again), /agents_delegate hands a whole task/);
  assert.match((await check(again)).detail, /waits until you allow it at this computer, in either access profile\.$/);
  const ended = await again.call('agents.delegate', { agentId: mine.id, prompt: 'Fourth', waitMs: 20000 }, connected);
  await again.call('delegation.update', { mode: 'off' }, local);
  assert.deepEqual([again.store.get('approval', ended.approvals[0].id).status, again.store.get('delivery', ended.deliveryId).status, again.store.get('delivery', ended.deliveryId).error],
    ['expired', 'cancelled', { code: 'delegation_off', message: 'The owner switched delegation off before this task was run.' }]);
  // Choosing to be asked means of every agent again, also one whose later tasks had been let through.
  await again.call('delegation.update', { mode: 'ask' }, local);
  const let1 = await again.call('agents.delegate', { agentId: mine.id, prompt: 'Fifth', waitMs: 20000 }, connected);
  await answer(again, let1.approvals[0].id, 'allow_agent');
  await again.call('agents.result', { agentId: mine.id, deliveryId: let1.deliveryId, waitMs: 5000 }, connected);
  assert.equal(again.store.get('agent', mine.id).delegationAllowed, true);
  await again.call('delegation.update', { mode: 'ask' }, local);
  assert.equal(again.store.get('agent', mine.id).delegationAllowed, false);
  // What waits when the runtime stops is not carried over: nothing runs unasked after a restart.
  const held = await again.call('agents.delegate', { agentId: mine.id, prompt: 'Sixth', waitMs: 20000 }, connected);
  assert.equal(held.approvals.length, 1);
  again = await restart();
  assert.deepEqual(await again.call('delegation.read', {}, local), { mode: 'ask' });
  assert.deepEqual([again.store.get('approval', held.approvals[0].id).status, again.store.get('delivery', held.deliveryId).status], ['expired', 'cancelled']);
  assert.ok(!turns(instances).includes('Sixth') && !turns(instances).includes('Fourth'));
});

test('a connected client starts no process and takes no place before a task of it is allowed', async t => {
  const { service, project, instances } = await fixture(t);
  await service.call('providers.configure', { provider: 'codex', settings: { maxSessions: 1 } }, local);
  // Three tasks for three new agents: three questions, and nothing else.
  const waiting = [];
  for (const name of ['one', 'two', 'three']) waiting.push(await delegated(service, project, name));
  assert.deepEqual([instances.length, service.agents.sessions.size, waiting.map(item => item.approvals.length)], [0, 0, [1, 1, 1]]);
  // The owner's own agent is not kept out by them, with room for one session only.
  const own = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Mine', waitMs: 20000 }, local);
  assert.deepEqual([own.output, instances.length], ['done: Mine', 1]);
  // Starting an agent's process again is not a client's to do on its own either, nor is putting more into a task.
  await assert.rejects(service.call('agents.resume', { id: waiting[0].agentId }, connected), { code: 'delegation_ask', message: /^An agent is started again for a connected client by a task, not on its own\. The owner is asked about each task .* hand it the task \(agents_delegate with agentId\)/ });
  assert.equal(instances.length, 1);
  // A task that is allowed while there is no room says that, and is not left waiting for a session it will not get.
  await answer(service, waiting[0].approvals[0].id, 'allow_once');
  const full = await service.call('agents.result', { agentId: waiting[0].agentId, deliveryId: waiting[0].deliveryId, waitMs: 5000 }, connected);
  assert.deepEqual([full.settled, full.error.code], [true, 'agent_limit']); assert.equal(instances.length, 1);
  // With room it is started, by the allowing.
  await service.call('agents.stop', { id: own.agentId }, local);
  await answer(service, waiting[1].approvals[0].id, 'allow_once');
  assert.equal((await service.call('agents.result', { agentId: waiting[1].agentId, deliveryId: waiting[1].deliveryId, waitMs: 5000 }, connected)).output, 'done: two');
  assert.deepEqual(turns(instances), ['Mine', 'two']);
});

test('the owner\'s word for an agent lets its other waiting tasks through, and what may wait for the owner at once is bounded', async t => {
  const { service, project, instances } = await fixture(t);
  // Several tasks wait for one agent. A refusal refuses the one; "do not ask again for this agent" lets the others
  // through with the one it was said on, without the owner answering each.
  const first = await delegated(service, project, 'one'), more = [];
  for (const name of ['two', 'three']) more.push(await delegated(service, project, name, { agentId: first.agentId }));
  const other = await delegated(service, project, 'for another agent');
  await answer(service, more[0].approvals[0].id, 'deny');
  await answer(service, first.approvals[0].id, 'allow_agent');
  assert.equal((await service.call('agents.result', { agentId: first.agentId, deliveryId: more[1].deliveryId, waitMs: 5000 }, connected)).output, 'done: three');
  assert.deepEqual(turns(instances), ['one', 'three']);
  assert.deepEqual([first, ...more].map(item => { const record = service.store.get('approval', item.approvals[0].id); return [record.status, record.answer.optionId, record.automatic === true]; }),
    [['resolved', 'allow_agent', false], ['resolved', 'deny', false], ['resolved', 'allow_once', true]]);
  assert.equal(service.store.get('approval', other.approvals[0].id).status, 'pending', 'said of one agent, not of another');
  await answer(service, other.approvals[0].id, 'deny');

  // A task that waits takes no process and no session, so what bounds the waiting is said outright: twenty at once.
  // The one beyond is refused before anything is made for it, with how many the owner has before them.
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Many' }, local);
  const piled = await service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'claude' }, connected);
  for (let count = 1; count <= 20; count++) await service.call('agents.send', { id: piled.id, body: 'task ' + count }, connected);
  const made = () => [service.store.count('workflow', { projectId: project.id }), service.store.count('agent', { projectId: project.id }), service.store.count('message', { projectId: project.id })], before = made();
  const full = { code: 'delegation_backlog', message: /^The owner has 20 task\(s\) of connected clients to allow or refuse and has not answered them yet\. No more are taken until they have \(at most 20 wait at once\): ask them to answer in the DevMate workbench at their computer, or take back tasks that are no longer wanted \(agents\.cancel\)\.$/ };
  await assert.rejects(service.call('agents.send', { id: piled.id, body: 'task 21' }, connected), full);
  await assert.rejects(delegated(service, project, 'for a new agent'), full);
  await assert.rejects(service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'codex', prompt: 'with a task' }, connected), full);
  assert.deepEqual(made(), before);
  // What waits counts against its workflow's turns like every task, and is given back when it is refused.
  assert.equal(service.store.get('workflow', workflow.id).usedTurns, 20);
  // The owner's own task is not one of them and is not kept out; and one that is answered makes room for one.
  assert.equal((await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Mine', waitMs: 20000 }, local)).output, 'done: Mine');
  const [oldest] = (await service.call('approval.list', { projectId: project.id, workflowId: workflow.id, status: 'pending' }, local)).items;
  await answer(service, oldest.id, 'deny');
  assert.equal(service.store.get('workflow', workflow.id).usedTurns, 19);
  await service.call('agents.send', { id: piled.id, body: 'task 21' }, connected);
  await assert.rejects(service.call('agents.send', { id: piled.id, body: 'task 22' }, connected), full);
  assert.deepEqual([instances.length, turns(instances)], [2, ['one', 'three', 'Mine']]);
});

test('every way into a task is asked about: a message, an assigned task, what an agent passes on for a client, and what is put into a task that runs', async t => {
  const { service, project, factory, instances } = await fixture(t);
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Two agents' }, local);
  const scope = { projectId: project.id, workflowId: workflow.id };
  // Two agents the owner started at the computer.
  const first = await service.call('agents.start', { ...scope, provider: 'codex', name: 'Builder' }, local);
  const second = await service.call('agents.start', { ...scope, provider: 'claude', name: 'Reviewer' }, local);
  await until(() => [first, second].every(agent => service.store.get('agent', agent.id).status === 'ready'), 'both agents');
  const pending = async () => (await service.call('approval.list', { ...scope, status: 'pending' }, local)).items;
  const allow = async what => { await until(async () => (await pending()).length === 1, what); const [item] = await pending(); await answer(service, item.id, 'allow_once'); return item; };
  const token = instance => instance.options.mcpServers.find(item => item.name === 'devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const builder = instances.find(instance => instance.options.provider === 'codex'), reviewer = instances.find(instance => instance.options.provider === 'claude');
  const inbox = instance => service.agents.channelCall(token(instance), 'agent_inbox', {}).items.map(item => [item.sender.label, item.body]);

  // A message and an assigned task from the client: each is a turn, and each waits. While it waits, and when it was
  // refused, its text is not the agent's to read either: read from the inbox it would be a task all the same.
  const message = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Build it' }, connected);
  assert.deepEqual(inbox(builder), []);
  assert.equal((await allow('the message to be asked about')).summary, 'A connected client asks codex (named "Builder") to run a task in Shop: Build it');
  await until(() => service.store.get('message', message.id).status === 'delivered', 'the message to be run');
  // What a client wrote is named as a client's, not as the owner's "You".
  assert.deepEqual(inbox(builder).slice(0, 1), [['Connected client', 'Build it']]);
  await service.call('message.send', { ...scope, recipientIds: [second.id], body: 'Refused words' }, connected);
  await until(async () => (await pending()).length === 1, 'the second message to be asked about');
  await answer(service, (await pending())[0].id, 'deny');
  assert.deepEqual(inbox(reviewer), [], 'what was refused never reaches the agent');
  const task = await service.call('task.create', { ...scope, title: 'Review', instruction: 'Review it', assigneeId: second.id }, connected);
  assert.deepEqual(turns(instances), ['Build it']);
  await allow('the task to be asked about');
  await until(() => service.store.get('task', task.id).status === 'completed', 'the task to be run');
  // The same from the owner at the computer runs at once, and reads as theirs.
  const own = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Build it my way' }, local);
  await until(() => service.store.get('message', own.id).status === 'delivered', 'the owner\'s message');
  assert.deepEqual(await pending(), []); assert.ok(inbox(builder).some(([label, body]) => label === 'You' && body === 'Build it my way'));

  // An agent writes to another while it works. What it writes on a task of the client is the client's, and is asked
  // about; so is what it writes after that task, until it works on one of the owner's; that is the owner's.
  let passed = 0;
  const pass = (instance, body) => service.agents.channelCall(token(instance), 'agent_send_message', { operationId: 'pass-' + ++passed, recipientIds: [second.id], body });
  factory.during = async (instance, text) => { if (instance === builder && text.startsWith('Pass it on')) pass(instance, 'From the builder: ' + text); };
  const relaying = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Pass it on for the client' }, connected);
  await allow('the client\'s message to the builder');
  const relayed = await allow('what the builder passed on for the client');
  assert.deepEqual([relayed.agentId, relayed.details.askedBy, relayed.summary], [second.id, 'The agent "Builder", which works for a connected client', 'The agent "Builder", which works for a connected client, asks claude (named "Reviewer") to run a task in Shop: From the builder: Pass it on for the client']);
  await until(() => turns(instances).some(text => text.endsWith('From the builder: Pass it on for the client')), 'the reviewer to be given it');
  await until(() => service.store.get('message', relaying.id).status === 'delivered', 'the client\'s task to end');
  pass(builder, 'After the client\'s task');
  const after = await allow('what the builder passed on after the client\'s task');
  assert.equal(after.details.task, 'After the client\'s task');
  const mine = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Pass it on for me' }, local);
  await until(() => turns(instances).some(text => text.endsWith('From the builder: Pass it on for me')), 'the reviewer to be given the owner\'s');
  await until(() => service.store.get('message', mine.id).status === 'delivered', 'the owner\'s message');
  pass(builder, 'After the owner\'s task');
  await until(() => turns(instances).some(text => text.endsWith('After the owner\'s task')), 'what the builder passed on after the owner\'s task');
  assert.deepEqual(await pending(), [], 'nothing of the owner\'s own was asked about');

  // Text put into a task that runs goes to the provider at once: the second way into a turn. A connected client does
  // not put it into a task of the owner's, nor into one that was allowed once.
  let finish; factory.open = new Promise(resolve => { finish = resolve; }); factory.during = null;
  const running = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'A long task of the owner\'s' }, local);
  await until(() => builder.sent.includes('A long task of the owner\'s'), 'the owner\'s task to run');
  await assert.rejects(service.call('agents.steer', { id: first.id, body: 'Do something else instead' }, connected), { code: 'delegation_ask', message: /^Steering a task that runs adds to it without the owner being asked\. The owner is asked about each task/ });
  await assert.rejects(service.call('operations.call', { operation: 'agents.steer', input: { id: first.id, body: 'Do something else instead' } }, connected), { code: 'delegation_ask' });
  assert.deepEqual(builder.steered, []);
  // The owner does, and what the agent passes on stays the owner's.
  await service.call('agents.steer', { id: first.id, body: 'A hint of mine' }, local);
  pass(builder, 'While the owner steers');
  await until(() => service.store.count('delivery', { ...scope, status: 'queued' }) + turns(instances).filter(text => text.endsWith('While the owner steers')).length > 0, 'it to be taken in');
  assert.deepEqual([builder.steered, (await pending()).length], [['A hint of mine'], 0]);
  // Where the owner chose not to be asked, a client steers; and from then on that task carries a client's words, so
  // that what the agent passes on is asked about again once the owner wants to be asked.
  await service.call('delegation.update', { mode: 'allow' }, local);
  await service.call('agents.steer', { id: first.id, body: 'A hint of the client\'s' }, connected);
  // A task of a client that was taken in without asking, and still waits its turn behind the one that runs, is not
  // run once the owner switches delegation off: nothing of a client's is left to run then.
  const behind = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Behind the long task' }, connected);
  assert.equal(service.store.get('delivery', behind.deliveries[0].id).status, 'queued');
  await service.call('delegation.update', { mode: 'off' }, local);
  assert.deepEqual([service.store.get('delivery', behind.deliveries[0].id).status, service.store.get('delivery', behind.deliveries[0].id).error.code], ['cancelled', 'delegation_off']);
  await service.call('delegation.update', { mode: 'ask' }, local);
  pass(builder, 'After the client steered');
  assert.equal((await allow('what is passed on after a client steered')).details.task, 'After the client steered');
  assert.deepEqual(builder.steered, ['A hint of mine', 'A hint of the client\'s']);
  finish(); factory.open = null;
  await until(() => service.store.get('message', running.id).status === 'delivered', 'the long task to end');
  assert.ok(!builder.sent.includes('Behind the long task'));
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
  assert.deepEqual([allowed.code, allowed.stdout, calls.at(-1)], [0, 'allow\n', ['delegation.update', { mode: 'allow' }]]); assert.match(allowed.stderr, /on your account with the provider\. Tasks that waited for your answer when you chose this were let through\. To be asked first: devmate delegation ask/);
  assert.match((await run(['delegation', 'off'])).stderr, /cannot hand tasks to the coding agents here; you still can, at this computer/);
  const wrong = await run(['delegation', 'never']);
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /delegation ask, delegation allow or delegation off/);
});
