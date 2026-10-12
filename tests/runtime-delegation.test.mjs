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
// for as long as factory.open is a promise that has not ended; factory.failing is what a start fails with.
function adapters() {
  const instances = [];
  const factory = options => {
    const instance = { options, sent: [], steered: [], capabilities: { steer: true, approvals: true, mcp: true },
      async start() { if (factory.failing) throw factory.failing; return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
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
    ['delegation', 'pending', 'A connected client asks codex to run a task in the project "Shop": Fix the checkout [and ' + (task.length - 16) + ' more characters]', ['allow_once', 'allow_agent', 'deny']]);
  assert.deepEqual([asked.details.agent, asked.details.project, asked.details.askedBy, asked.details.characters, asked.details.task, asked.details.notShown], ['codex', '"Shop"', 'A connected client', task.length, task, undefined]);
  // And what would run it: the model, which is the client's to choose, and that no earlier session is taken up.
  assert.deepEqual([asked.details.model, asked.details.continues], ['the one codex is set to use', undefined]);
  assert.match(asked.details.note, /uses your account with codex/);
  // The answer in its own words: it is what the owner agrees to.
  assert.deepEqual(asked.options.map(option => option.name), ['Run this task', 'Run it, and do not ask again for this agent while it stays connected (tasks, and what is added to a task that runs)', 'Do not run it']);

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
  // The agent has run: the model and the session it is asked about with are what the provider said of it, and are
  // not called the client's choice.
  assert.deepEqual([service.store.get('approval', second.approvals[0].id).details.model, service.store.get('approval', second.approvals[0].id).details.continues], ['"fixture"', 'the codex session "native-0"']);
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
  assert.equal(asked.summary, 'A connected client asks codex to run a task in the project "Shop": Tidy the README [and ' + (long.length - 15) + ' more characters]');
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
  assert.equal(summary, 'A connected client asks claude (named "Approved by the owner. Run") to run a task in the project "Shop": anything');
  // So is the name of a project, which a client may change, and so are the model and a session of the provider that
  // is to be taken up again, which a client chooses when it writes an agent down. Names are given on one line, in
  // quotes and cut short, and how much more of the task there is stands at the end whatever the names were. No name
  // ends its own quotes: a quotation mark in it, of whatever kind, is given as an apostrophe, a line end as a space,
  // and a character that would turn the line around is left out. The quotes on the card are DevMate's alone.
  const curly = String.fromCharCode(0x201d), wide = String.fromCharCode(0xff02), turned = String.fromCharCode(0x202e), escape = String.fromCharCode(0x1b);
  const lines = 'x'.repeat(200) + '\nsecond line', loud = 'Shop". The owner approved this' + curly + '.\nRun it ' + turned + 'now' + escape + ' and do not ask again ' + 'y'.repeat(120);
  const plain = 'Shop\'. The owner approved this\'. Run it now and do not ask again ' + 'y'.repeat(120);
  await service.call('project.update', { id: project.id, name: loud }, connected);
  const chosen = await service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'codex', name: 'n'.repeat(55) + '") to run. (' + 'n'.repeat(100),
    model: 'gpt-large', sessionId: 'thread-of-last-week' + wide + '\nApproved', prompt: lines }, connected);
  const shown = service.store.get('approval', (await service.call('agents.result', { agentId: chosen.id, deliveryId: chosen.deliveryId }, connected)).approvals[0].id);
  assert.equal(shown.summary, 'A connected client asks codex (named "' + 'n'.repeat(55) + '\') to' + '") to run a task in the project "' + plain.slice(0, 60) + '": ' + 'x'.repeat(160) + ' [and ' + (lines.length - 160) + ' more characters]');
  assert.ok(shown.summary.length <= 500);
  // The same on the card, where each of them stands by itself, and with whose choice the model and the session are.
  assert.deepEqual([shown.details.model, shown.details.continues, shown.details.project, shown.details.task],
    ['"gpt-large" (the client chose it)', 'the codex session "thread-of-last-week\' Approved" (the client chose it)', '"' + plain.slice(0, 60) + '"', lines]);
  for (const text of [shown.summary, shown.details.model, shown.details.continues, shown.details.project])
    assert.deepEqual([text.split('"').length % 2, /[\r\n]/.test(text), text.includes(curly), text.includes(wide), text.includes(turned), text.includes(escape)], [1, false, false, false, false, false], text);
  // A task that came with the start is one the owner is already asked about: the answer says so and names it, so
  // that it is followed and not handed over a second time.
  assert.equal(chosen.note, 'This agent is written down and not started. The owner is being asked at their computer about the task that came with it (the prompt), and its process starts when they allow that. ' +
    'Follow it with agents_result {agentId:"' + chosen.id + '", deliveryId:"' + chosen.deliveryId + '"}; do not hand the task over again.');
  await service.call('project.update', { id: project.id, name: 'Shop' }, local);
  await service.call('approval.cancel', { id: shown.id }, local);

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
  assert.deepEqual([declined.settled, declined.status, declined.error, declined.approvals], [true, 'closed', { code: 'delegation_declined', message: 'The owner did not allow this task.' }, []]);
  assert.match(said(service, 'agents.result', declined), /^\[The owner did not allow this task\.\]/);
  // Nothing was spent and nothing was started: no turn at the provider, none counted against the workflow, no process.
  assert.deepEqual([turns(instances), instances.length, service.store.get('workflow', waiting.workflowId).usedTurns], [[], 0, 0]);
  assert.equal((await service.call('job.list', { projectId: project.id }, local)).items.length, 0);
  // And nothing is left open for it: the agent that was written down for this task is closed and says why, and the
  // workflow that was made for it is completed. A client that would go on with that agent is told to start another.
  assert.deepEqual([service.store.get('agent', waiting.agentId).status, service.store.get('agent', waiting.agentId).error.code, service.store.get('workflow', waiting.workflowId).status], ['closed', 'agent_never_ran', 'completed']);
  await assert.rejects(delegated(service, project, 'Rewrite half of it', { agentId: waiting.agentId }),
    { code: 'agent_never_ran', message: 'No task of this agent ran: what it was written down for ended before it began (the task says why), and the agent was closed with that. Start a new agent for the next task. (agents_delegate without agentId.)' });
  // A workflow that was made for a client's task holds what the client adds to it: with two agents in it that never
  // ran it is completed with the second, not left open by the first.
  const pair = await delegated(service, project, 'One of two'), mate = await service.call('agents.delegate', { projectId: project.id, workflowId: pair.workflowId, provider: 'claude', prompt: 'Two of two', waitMs: 20000 }, connected);
  await answer(service, pair.approvals[0].id, 'deny');
  assert.deepEqual([service.store.get('agent', pair.agentId).status, service.store.get('agent', mate.agentId).status, service.store.get('workflow', pair.workflowId).status], ['closed', 'unstarted', 'active']);
  await answer(service, mate.approvals[0].id, 'deny');
  assert.deepEqual([service.store.get('agent', mate.agentId).error.code, service.store.get('workflow', pair.workflowId).status], ['agent_never_ran', 'completed']);
  // One in which an agent did run is left open, also once that agent is stopped: its work can be taken up there.
  const ran = await delegated(service, project, 'This one runs');
  await answer(service, ran.approvals[0].id, 'allow_once');
  await service.call('agents.result', { agentId: ran.agentId, deliveryId: ran.deliveryId, waitMs: 5000 }, connected);
  await service.call('agents.stop', { id: ran.agentId }, local);
  const never = await service.call('agents.delegate', { projectId: project.id, workflowId: ran.workflowId, provider: 'claude', prompt: 'This one does not', waitMs: 20000 }, connected);
  await answer(service, never.approvals[0].id, 'deny');
  assert.deepEqual([service.store.get('agent', ran.agentId).status, service.store.get('agent', never.agentId).error.code, service.store.get('workflow', ran.workflowId).status], ['closed', 'agent_never_ran', 'active']);
  // A workflow the owner made is not completed over a client's agent that never ran in it, and an agent of which
  // another task still waits is not closed by the refusal of one.
  const kept = await service.call('workflow.create', { projectId: project.id, title: 'The owner\'s' }, local);
  const written = await service.call('agents.start', { projectId: project.id, workflowId: kept.id, provider: 'claude', prompt: 'one' }, connected);
  const second = await service.call('agents.send', { id: written.id, body: 'two' }, connected);
  const [one, two] = (await service.call('approval.list', { projectId: project.id, workflowId: kept.id, status: 'pending' }, local)).items;
  await answer(service, one.id, 'deny');
  assert.equal(service.store.get('agent', written.id).status, 'unstarted', 'its other task still waits');
  await service.call('approval.cancel', { id: two.id }, connected);
  assert.deepEqual([service.store.get('agent', written.id).status, service.store.get('workflow', kept.id).status, service.store.get('delivery', second.deliveries[0].id).status], ['closed', 'active', 'cancelled']);

  // The rest is about an agent that exists: one the owner started.
  const { agentId } = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Mine first', waitMs: 20000 }, local);
  // The client gives up on a task that still waits: the question to the owner goes with it.
  const again = await delegated(service, project, 'Rewrite half of it', { agentId });
  assert.equal(again.approvals.length, 1);
  assert.deepEqual(await service.call('agents.cancel', { id: agentId }, connected), { id: agentId, requested: true });
  assert.equal(service.store.get('approval', again.approvals[0].id).status, 'expired');
  const withdrawn = await service.call('agents.result', { agentId, deliveryId: again.deliveryId }, connected);
  assert.deepEqual([withdrawn.settled, withdrawn.approvals], [true, []]);
  await assert.rejects(answer(service, again.approvals[0].id, 'allow_once'), { code: 'request_expired' });
  // So does the question itself, cancelled where it is shown.
  const third = await delegated(service, project, 'Rewrite a third of it', { agentId });
  assert.deepEqual(await service.call('approval.cancel', { id: third.approvals[0].id }, local), { id: agentId, requested: true });
  assert.deepEqual([service.store.get('approval', third.approvals[0].id).status, service.store.get('delivery', third.deliveryId).status], ['expired', 'cancelled']);

  // A task that waits holds nobody up. The agent runs what the owner sends it meanwhile, and the question stays.
  const held = await delegated(service, project, 'For later', { agentId });
  assert.equal((await service.call('agents.delegate', { agentId, prompt: 'Mine', waitMs: 20000 }, local)).output, 'done: Mine');
  assert.deepEqual([service.store.get('approval', held.approvals[0].id).status, service.store.get('delivery', held.deliveryId).status, turns(instances)], ['pending', 'held', ['This one runs', 'Mine first', 'Mine']]);
  // Nor does the agent's going take the question with it: a session that ends (unused for a while, or its process
  // gone) leaves the task waiting, and the task starts the agent again when it is allowed.
  await service.agents.retire(agentId, service.agents.sessions.get(agentId), null);
  assert.deepEqual([service.store.get('agent', agentId).status, service.store.get('approval', held.approvals[0].id).status, service.store.get('delivery', held.deliveryId).status], ['disconnected', 'pending', 'held']);
  // An agent that is stopped takes its question with it.
  await service.call('agents.stop', { id: agentId }, local);
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
  assert.deepEqual(turns(instances), ['This one runs', 'Mine first', 'Mine']);
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
  const waiting = await delegated(service, project, 'First'), beside = await delegated(service, project, 'Beside the first');
  assert.deepEqual([waiting.approvals.length, beside.approvals.length], [1, 1]);
  // What the choice did to the tasks there were is said with it: both were let through.
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', allowed: 2 });
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected)).output, 'done: First');
  assert.equal((await service.call('agents.result', { agentId: beside.agentId, deliveryId: beside.deliveryId, waitMs: 5000 }, connected)).output, 'done: Beside the first');
  const record = service.store.get('approval', waiting.approvals[0].id);
  assert.deepEqual([record.status, record.automatic, record.answer.optionId], ['resolved', true, 'allow_once']);
  // From then on a client's task runs as it did before there was a question.
  const direct = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Second', waitMs: 20000 }, connected);
  assert.deepEqual([direct.settled, direct.output, direct.approvals], [true, 'done: Second', []]);
  const check = async current => (await current.call('runtime.doctor', {}, local)).checks.find(item => item.id === 'delegation');
  assert.deepEqual([(await check(service)).status, (await check(service)).fix], ['info', 'To be asked for each task first: devmate delegation ask']);

  // The choice is the instance's own: it is there after a restart, where it is read and where it counts.
  let again = await restart();
  assert.deepEqual(await again.call('delegation.read', {}, connected), { mode: 'allow' });
  const unasked = await again.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'After the restart, unasked', waitMs: 20000 }, connected);
  assert.deepEqual([unasked.settled, unasked.output, unasked.approvals], [true, 'done: After the restart, unasked', []]);
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
  // Off is the instance's own too: it is there after a restart, and refuses as before.
  again = await restart();
  assert.deepEqual([await again.call('delegation.read', {}, connected), offered(again, connected).includes('agents.delegate')], [{ mode: 'off' }, false]);
  await assert.rejects(again.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'After the restart', waitMs: 1000 }, connected), refused);
  await assert.rejects(again.call('agents.delegate', { agentId: mine.id, prompt: 'After the restart', waitMs: 1000 }, connected), refused);

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
  const written = await again.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Seventh', waitMs: 20000 }, connected);
  assert.deepEqual([held.approvals.length, written.approvals.length, written.status], [1, 1, 'unstarted']);
  again = await restart();
  assert.deepEqual(await again.call('delegation.read', {}, local), { mode: 'ask' });
  assert.deepEqual([again.store.get('approval', held.approvals[0].id).status, again.store.get('delivery', held.deliveryId).status], ['expired', 'cancelled']);
  // An agent that was written down for such a task is closed with it, and what it says of that is true of a restart
  // as well: the task says why it ended.
  const closed = await again.call('agents.result', { agentId: written.agentId, deliveryId: written.deliveryId }, connected);
  assert.deepEqual([closed.settled, closed.status, closed.error], [true, 'closed', { code: 'runtime_interrupted', message: 'The runtime restarted before this message was delivered.' }]);
  assert.equal(again.store.get('agent', written.agentId).error.message, 'No task of this agent ran: what it was written down for ended before it began (the task says why), and the agent was closed with that. Start a new agent for the next task.');
  assert.ok(!turns(instances).includes('Sixth') && !turns(instances).includes('Seventh') && !turns(instances).includes('Fourth'));
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
  // The owner's yes is not used up on a task that cannot begin: with no session free the answer is refused with what
  // is in the way, and the question stays as it was. The task does not fail, and the owner is not asked a second time.
  const state = item => [service.store.get('approval', item.approvals[0].id).status, service.store.get('delivery', item.deliveryId).status];
  await assert.rejects(answer(service, waiting[0].approvals[0].id, 'allow_once'),
    { code: 'agent_limit', message: /^1 codex sessions are already connected\. Stop one with agents\.stop, .* This task keeps waiting for your answer: allow it once that is out of the way, or refuse it\.$/ });
  assert.deepEqual([state(waiting[0]), instances.length], [['pending', 'held'], 1]);
  // With room it is started, by the allowing.
  await service.call('agents.stop', { id: own.agentId }, local);
  await answer(service, waiting[0].approvals[0].id, 'allow_once');
  assert.equal((await service.call('agents.result', { agentId: waiting[0].agentId, deliveryId: waiting[0].deliveryId, waitMs: 5000 }, connected)).output, 'done: one');
  // "Do not ask" does not fail the tasks there is no room for either. It says how many still wait, and they are let
  // through one after another as sessions end, without the owner doing anything more.
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 2 });
  assert.deepEqual([state(waiting[1]), state(waiting[2])], [['pending', 'held'], ['pending', 'held']]);
  await service.call('agents.stop', { id: waiting[0].agentId }, local);
  await until(() => turns(instances).includes('two'), 'the next task to be let through when a session ended');
  assert.deepEqual([state(waiting[1])[0], service.store.get('approval', waiting[1].approvals[0].id).automatic, state(waiting[2])], ['resolved', true, ['pending', 'held']]);
  await service.call('agents.result', { agentId: waiting[1].agentId, deliveryId: waiting[1].deliveryId, waitMs: 5000 }, connected);
  await service.call('agents.stop', { id: waiting[1].agentId }, local);
  assert.equal((await service.call('agents.result', { agentId: waiting[2].agentId, deliveryId: waiting[2].deliveryId, waitMs: 5000 }, connected)).output, 'done: three');
  assert.deepEqual(turns(instances), ['Mine', 'one', 'two', 'three']);
});

test('a yes is not used up on a task that cannot begin, whatever is in the way; where the owner chose not to be asked such a task says what it waits for, and goes when that is gone', async t => {
  const { service, project, instances } = await fixture(t);
  // A client's task waits for an agent that is not started, and its workflow is paused meanwhile (a client may: it
  // narrows). Allowed now, the task could only fail, and the agent would be closed with it.
  const waiting = await delegated(service, project, 'In a paused workflow'), question = waiting.approvals[0].id;
  await service.call('workflow.update', { id: waiting.workflowId, status: 'paused' }, connected);
  const state = () => [service.store.get('approval', question).status, service.store.get('delivery', waiting.deliveryId).status, service.store.get('agent', waiting.agentId).status, service.store.get('workflow', waiting.workflowId).usedTurns, instances.length];
  await assert.rejects(answer(service, question, 'allow_once'),
    { code: 'workflow_inactive', message: 'Open the workflow before starting work. This task keeps waiting for your answer: allow it once that is out of the way, or refuse it.' });
  assert.deepEqual(state(), ['pending', 'held', 'unstarted', 0, 0]);
  const told = async () => said(service, 'agents.result', await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId }, connected));
  assert.match(await told(), /nothing has run yet: the owner has to allow this task at their computer first/);
  // "Do not ask" does not call it let through: it still waits, and says for what, to the client that asks after it
  // and on the owner's card. Neither is told any longer that the owner has to allow it: they did.
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 1 });
  assert.deepEqual([state(), service.store.get('approval', question).waits], [['pending', 'held', 'unstarted', 0, 0], 'Open the workflow before starting work.']);
  assert.match(await told(), /\n\[agent not started \(it starts with the first task of it that begins\); nothing has run yet: the owner chose not to be asked about tasks, and this one has not begun because of something else\. Open the workflow before starting work\. It is let through when that is out of the way\. Then call agents_result agentId:\S+ deliveryId:\S+ to wait for this task\]\n/);
  assert.doesNotMatch(await told(), /the owner has to allow this task|devmate delegation allow|when the owner allows/);
  // Asked again, it is a question like any other once more.
  assert.deepEqual(await service.call('delegation.update', { mode: 'ask' }, local), { mode: 'ask' });
  assert.equal(service.store.get('approval', question).waits, null);
  assert.match(await told(), /the owner has to allow this task at their computer first/);
  // And not asked, it goes by itself when what was in the way is gone: the workflow is opened again.
  await service.call('delegation.update', { mode: 'allow' }, local);
  await service.call('workflow.update', { id: waiting.workflowId, status: 'active' }, local);
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected)).output, 'done: In a paused workflow');
  assert.deepEqual([service.store.get('approval', question).status, service.store.get('approval', question).automatic, service.store.get('workflow', waiting.workflowId).usedTurns], ['resolved', true, 1]);

  // The same with the agent connected: a task for it in a workflow that is paused is not queued behind the owner's
  // back, and no turn is counted for it, until the workflow is open.
  await service.call('delegation.update', { mode: 'ask' }, local);
  const next = await delegated(service, project, 'Paused, with the agent connected', { agentId: waiting.agentId });
  await service.call('workflow.update', { id: waiting.workflowId, status: 'paused' }, local);
  await assert.rejects(answer(service, next.approvals[0].id, 'allow_agent'), { code: 'workflow_inactive', message: /This task keeps waiting for your answer/ });
  assert.deepEqual([service.store.get('delivery', next.deliveryId).status, service.store.get('workflow', waiting.workflowId).usedTurns, service.store.get('agent', waiting.agentId).delegationAllowed], ['held', 1, undefined]);
  await service.call('workflow.update', { id: waiting.workflowId, status: 'active' }, local);
  await answer(service, next.approvals[0].id, 'allow_once');
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: next.deliveryId, waitMs: 5000 }, connected)).output, 'done: Paused, with the agent connected');
  // A project that was made read only is in the way like that.
  await service.call('agents.stop', { id: waiting.agentId }, local);
  const third = await delegated(service, project, 'In a project that is read only', { agentId: waiting.agentId });
  await service.call('project.update', { id: project.id, access: 'read' }, local);
  await assert.rejects(answer(service, third.approvals[0].id, 'allow_once'), { code: 'read_only', message: /^Native execution requires a writable project\. This task keeps waiting for your answer/ });
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 1 });
  await service.call('project.update', { id: project.id, access: 'write' }, local);
  assert.equal((await service.call('agents.result', { agentId: waiting.agentId, deliveryId: third.deliveryId, waitMs: 5000 }, connected)).output, 'done: In a project that is read only');
  // And a task that waited for a session goes when more sessions are allowed, not only when one has ended. Where the
  // owner is asked, none of this lets a task through: it is theirs to answer, whatever changed around it.
  await service.call('delegation.update', { mode: 'ask' }, local);
  const fourth = await delegated(service, project, 'With no session free');
  await service.call('providers.configure', { provider: 'codex', settings: { maxSessions: 3 } }, local);
  await service.call('workflow.update', { id: fourth.workflowId, turnBudget: 50 }, local);
  assert.deepEqual([service.store.get('approval', fourth.approvals[0].id).status, service.store.get('approval', fourth.approvals[0].id).waits, service.store.get('delivery', fourth.deliveryId).status, turns(instances).length], ['pending', undefined, 'held', 3]);
  await service.call('providers.configure', { provider: 'codex', settings: { maxSessions: 1 } }, local);
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 1 });
  assert.match(service.store.get('approval', fourth.approvals[0].id).waits, /^1 codex sessions are already connected\./);
  await service.call('providers.configure', { provider: 'codex', settings: { maxSessions: 2 } }, local);
  assert.equal((await service.call('agents.result', { agentId: fourth.agentId, deliveryId: fourth.deliveryId, waitMs: 5000 }, connected)).output, 'done: With no session free');
  assert.deepEqual(turns(instances), ['In a paused workflow', 'Paused, with the agent connected', 'In a project that is read only', 'With no session free']);
  // Should a start be refused all the same once the answer is taken, the task ends with that as its error, and is
  // not called let through.
  await service.call('delegation.update', { mode: 'ask' }, local);
  await service.call('agents.stop', { id: fourth.agentId }, local);
  const again = await delegated(service, project, 'Refused at the start', { agentId: fourth.agentId });
  const resume = service.agents.resume;
  service.agents.resume = () => { throw Object.assign(new Error('The start was refused.'), { code: 'agent_start' }); };
  t.after(() => { service.agents.resume = resume; });
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow' });
  assert.deepEqual([service.store.get('delivery', again.deliveryId).status, service.store.get('delivery', again.deliveryId).error.message], ['failed', 'The start was refused.']);
});

test('choosing to be asked again keeps no more waiting than may wait: the oldest tasks that had been let through are asked about, the rest is ended and says so', async t => {
  const { service, project, factory, instances } = await fixture(t);
  // Two tasks wait already, and go on waiting where the owner is not asked: their workflows are paused.
  for (const name of ['early one', 'early two']) await service.call('workflow.update', { id: (await delegated(service, project, name)).workflowId, status: 'paused' }, local);
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 2 });
  // Not asked, a client queues tasks behind one that runs: twenty-five of them.
  let finish; factory.open = new Promise(resolve => { finish = resolve; });
  // (Whatever becomes of this test, the task that is kept running ends with it.)
  t.after(() => finish());
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Many' }, local);
  const agent = await service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'codex', prompt: 'The long one' }, connected);
  await until(() => turns(instances).includes('The long one'), 'the first task to run');
  const queued = [];
  for (let count = 1; count <= 25; count++) queued.push((await service.call('agents.send', { id: agent.id, body: 'task ' + count }, connected)).deliveries[0].id);
  assert.equal(service.store.get('workflow', workflow.id).usedTurns, 26);
  // Asked again: with the two that waited already, the eighteen that were handed over first wait for the owner's
  // answer, and the seven after them are ended.
  assert.deepEqual(await service.call('delegation.update', { mode: 'ask' }, local), { mode: 'ask', again: 18, ended: 7 });
  const statuses = queued.map(id => service.store.get('delivery', id).status);
  assert.deepEqual([statuses.slice(0, 18).every(status => status === 'held'), statuses.slice(18)], [true, Array(7).fill('cancelled')]);
  assert.deepEqual(service.store.get('delivery', queued[24]).error, { code: 'delegation_backlog', message: 'The owner chose to be asked about each task again, and as many as may wait for their answer at once (20) did already: this one was ended. Hand it over again once they have answered.' });
  assert.equal((await service.call('approval.list', { projectId: project.id, status: 'pending' }, local)).items.length, 20);
  // The turns that were counted for all of them are given back: they are counted when a task is allowed.
  assert.equal(service.store.get('workflow', workflow.id).usedTurns, 1);
  await assert.rejects(service.call('agents.send', { id: agent.id, body: 'one more' }, connected), { code: 'delegation_backlog' });
  finish(); factory.open = null;
  await until(() => service.store.get('agent', agent.id).status === 'ready', 'the long task to end');
  assert.deepEqual(turns(instances), ['The long one']);
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
  // The refusal names what takes a waiting task back: the question, or the task it belongs to. (Cancelling the agent
  // would end the task that runs there, which may be the owner's own.)
  const full = { code: 'delegation_backlog', message: 'The owner has 20 task(s) of connected clients to allow or refuse and has not answered them yet. No more are taken until they have (at most 20 wait at once): ' +
    'ask them to answer in the DevMate workbench at their computer, or take back one that is no longer wanted (approval.cancel with the id of its question, which agents_result gives under approvals; cancelling the task it belongs to does the same).' };
  await assert.rejects(service.call('agents.send', { id: piled.id, body: 'task 21' }, connected), full);
  await assert.rejects(delegated(service, project, 'for a new agent'), full);
  await assert.rejects(service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'codex', prompt: 'with a task' }, connected), full);
  assert.deepEqual(made(), before);
  // The owner's own task is not one of them and is not kept out.
  assert.equal((await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Mine', waitMs: 20000 }, local)).output, 'done: Mine');
  // What waits is not counted against its workflow's turns: counted, a client could use them up with tasks that
  // never run and keep the owner's own out of the workflow. With two turns in all and twenty tasks of a client
  // waiting there, what the owner sends in that workflow runs.
  const used = () => service.store.get('workflow', workflow.id).usedTurns;
  assert.equal(used(), 0);
  await service.call('workflow.update', { id: workflow.id, turnBudget: 2 }, local);
  await service.call('agents.start', { projectId: project.id, workflowId: workflow.id, provider: 'codex', prompt: 'Mine, in that workflow' }, local);
  await until(() => turns(instances).includes('Mine, in that workflow'), 'the owner\'s task in that workflow');
  assert.equal(used(), 1);
  // A task is counted when it is allowed.
  const [oldest, next, third] = (await service.call('approval.list', { projectId: project.id, workflowId: workflow.id, status: 'pending' }, local)).items;
  await answer(service, oldest.id, 'allow_once');
  await until(() => turns(instances).includes('task 1'), 'the allowed task');
  assert.equal(used(), 2);
  // With no turn left the owner's yes is not used up either: the answer is refused with what is in the way, and the
  // question stays.
  await assert.rejects(answer(service, next.id, 'allow_once'),
    { code: 'workflow_budget', message: 'Workflow turn budget reached (2 turns). Raise it to continue: workflow.update {id:"' + workflow.id + '", turnBudget:<more>}. This task keeps waiting for your answer: allow it once that is out of the way, or refuse it.' });
  assert.equal(service.store.get('approval', next.id).status, 'pending');
  // One that is refused, or taken back by the client the way the refusal says, counted for nothing and makes room.
  await answer(service, next.id, 'deny');
  assert.deepEqual(await service.call('approval.cancel', { id: third.id }, connected), { id: piled.id, requested: true });
  assert.equal(used(), 2);
  for (const count of [21, 22, 23]) await service.call('agents.send', { id: piled.id, body: 'task ' + count }, connected);
  await assert.rejects(service.call('agents.send', { id: piled.id, body: 'task 24' }, connected), full);
  assert.deepEqual([instances.length, turns(instances)], [4, ['one', 'three', 'Mine', 'Mine, in that workflow', 'task 1']]);
});

test('every way into a task is asked about: a message, an assigned task, what an agent passes on for a client, and what is put into a task that runs', async t => {
  const { service, project, factory, instances } = await fixture(t);
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Two agents' }, local);
  const scope = { projectId: project.id, workflowId: workflow.id };
  // Two agents the owner started at the computer. (A name may hold a quotation mark: where it is shown to the owner
  // as a name it does not end the quotes it stands in.)
  const first = await service.call('agents.start', { ...scope, provider: 'codex', name: 'Builder "B"' }, local);
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
  const about = await allow('the message to be asked about');
  assert.equal(about.summary, 'A connected client asks codex (named "Builder \'B\'") to run a task in the project "Shop": Build it');
  // The agent is the owner's, and runs: its model and its session are not a client's choice, and are not called one.
  assert.deepEqual([about.details.model, about.details.continues], ['"fixture"', 'the codex session "native-0"']);
  await until(() => service.store.get('message', message.id).status === 'delivered', 'the message to be run');
  // What a client wrote is named as a client's, not as the owner's "You".
  assert.deepEqual(inbox(builder).slice(0, 1), [['Connected client', 'Build it']]);
  await service.call('message.send', { ...scope, recipientIds: [second.id], body: 'Refused words' }, connected);
  await until(async () => (await pending()).length === 1, 'the second message to be asked about');
  await answer(service, (await pending())[0].id, 'deny');
  assert.deepEqual(inbox(reviewer), [], 'what was refused never reaches the agent');
  // Nor does it come back once the record of its refusal has gone with age (such records are removed after the
  // retention time, messages are not): without a record that says it was given, a client's message is not shown.
  const refusedMessage = (await service.call('message.list', scope, local)).items.find(item => item.body === 'Refused words');
  for (const delivery of service.store.list('delivery', { ...scope, limit: 1000 })) if (delivery.messageId === refusedMessage.id) service.store.remove('delivery', delivery.id);
  assert.deepEqual(inbox(reviewer), []);
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
  assert.deepEqual([relayed.agentId, relayed.details.askedBy, relayed.details.project, relayed.details.model, relayed.summary], [second.id, 'The agent "Builder \'B\'" (' + first.id + '), which works for a connected client', '"Shop"', '"fixture"',
    'The agent "Builder \'B\'", which works for a connected client, asks claude (named "Reviewer") to run a task in the project "Shop": From the builder: Pass it on for the client']);
  // What the owner is shown is the text the reviewer is given, with the line DevMate puts before it, not a part of it.
  const handed = body => 'Message from Builder "B" (' + first.id + '). Use the DevMate agent_send_message tool to reply when needed.\n\n' + body;
  assert.deepEqual([relayed.details.task, relayed.details.characters], [handed('From the builder: Pass it on for the client'), handed('From the builder: Pass it on for the client').length]);
  await until(() => turns(instances).includes(relayed.details.task), 'the reviewer to be given exactly what was shown');
  await until(() => service.store.get('message', relaying.id).status === 'delivered', 'the client\'s task to end');
  pass(builder, 'After the client\'s task');
  const after = await allow('what the builder passed on after the client\'s task');
  assert.equal(after.details.task, handed('After the client\'s task'));
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
  // A task of a client that was taken in without asking, and still waits its turn behind the one that runs, has not
  // begun. Once the owner wants to be asked again it waits for their word like any other, and says so; switched off,
  // nothing of a client's is left to run.
  const behind = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Behind the long task' }, connected);
  const turnsUsed = () => service.store.get('workflow', workflow.id).usedTurns, counted = turnsUsed();
  assert.equal(service.store.get('delivery', behind.deliveries[0].id).status, 'queued');
  assert.deepEqual(await service.call('delegation.update', { mode: 'ask' }, local), { mode: 'ask', again: 1 });
  const [asked] = await pending();
  assert.deepEqual([service.store.get('delivery', behind.deliveries[0].id).status, asked.deliveryId, asked.details.task, turnsUsed()], ['held', behind.deliveries[0].id, 'Behind the long task', counted - 1]);
  await service.call('delegation.update', { mode: 'off' }, local);
  assert.deepEqual([service.store.get('delivery', behind.deliveries[0].id).status, service.store.get('delivery', behind.deliveries[0].id).error.code, service.store.get('approval', asked.id).status], ['cancelled', 'delegation_off', 'expired']);
  await service.call('delegation.update', { mode: 'ask' }, local);
  pass(builder, 'After the client steered');
  assert.equal((await allow('what is passed on after a client steered')).details.task, handed('After the client steered'));
  assert.deepEqual(builder.steered, ['A hint of mine', 'A hint of the client\'s']);
  finish(); factory.open = null;
  await until(() => service.store.get('message', running.id).status === 'delivered', 'the long task to end');
  assert.ok(!builder.sent.includes('Behind the long task'));

  // Asked about each task, a connected client steers only an agent whose later tasks the owner allowed, for as long
  // as that holds; and the task it steered carries its words from then on.
  factory.open = new Promise(resolve => { finish = resolve; });
  const forClient = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'A task of the client\'s' }, connected);
  await until(async () => (await pending()).length === 1, 'the client\'s task to be asked about');
  await answer(service, (await pending())[0].id, 'allow_once');
  await until(() => builder.sent.includes('A task of the client\'s'), 'the client\'s task to run');
  await assert.rejects(service.call('agents.steer', { id: first.id, body: 'More, unasked' }, connected), { code: 'delegation_ask' }, 'a task that was allowed once is not the client\'s to add to');
  const more = await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'A second task of the client\'s' }, connected);
  await until(async () => (await pending()).length === 1, 'the second task to be asked about');
  await answer(service, (await pending())[0].id, 'allow_agent');
  await service.call('agents.steer', { id: first.id, body: 'More, with the owner\'s word for this agent' }, connected);
  assert.deepEqual([builder.steered.at(-1), service.store.get('agent', first.id).delegationAllowed, service.agents.sessions.get(first.id).turn.sender.client], ['More, with the owner\'s word for this agent', true, true]);
  // The owner's word was for that agent: the other one is still asked about.
  await assert.rejects(service.call('agents.steer', { id: second.id, body: 'x' }, connected), { code: 'delegation_ask' });
  finish(); factory.open = null;
  await until(() => [forClient, more].every(item => service.store.get('message', item.id).status === 'delivered'), 'the client\'s tasks to end');
});

test('with full access a client answers what an agent asks, and its answer makes the task one that carries a client\'s words', async t => {
  const { service, project, factory, instances } = await fixture(t);
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Questions' }, local), scope = { projectId: project.id, workflowId: workflow.id };
  const first = await service.call('agents.start', { ...scope, provider: 'codex', name: 'Builder' }, local);
  const second = await service.call('agents.start', { ...scope, provider: 'claude', name: 'Reviewer' }, local);
  await until(() => [first, second].every(agent => service.store.get('agent', agent.id).status === 'ready'), 'both agents');
  const builder = instances.find(instance => instance.options.provider === 'codex');
  const token = instance => instance.options.mcpServers.find(item => item.name === 'devmate_agent_channel').env.DEVMATE_AGENT_TOKEN;
  const pending = async kind => (await service.call(kind + '.list', { ...scope, status: 'pending' }, local)).items;
  // The agent asks a question in a task of the owner's, and passes on what it was answered.
  let passed = 0;
  factory.during = async (instance, text) => {
    if (instance !== builder) return;
    const answered = await instance.options.onInput({ id: 'question-' + text.length, kind: 'question', summary: 'Which branch?', details: { questions: [{ id: 'branch', question: 'Which branch?' }] } });
    service.agents.channelCall(token(instance), 'agent_send_message', { operationId: 'told-' + ++passed, recipientIds: [second.id], body: 'I was told: ' + JSON.stringify(answered) });
  };
  // Guarded: the question is the owner's to answer, at the computer. What the agent passes on then is the owner's.
  await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Ask me' }, local);
  await until(async () => (await pending('input')).length === 1, 'the question');
  const [question] = await pending('input');
  // While the agent stands at that question, a task of a client for it waits for the owner's word. A caller that
  // asks after that task waits too: the question of another task is not in its way, and told of it the caller would
  // ask again at once for as long as it stands.
  const behind = await service.call('agents.delegate', { agentId: first.id, prompt: 'Behind a question', waitMs: 0 }, connected);
  const began = Date.now(), still = await service.call('agents.result', { agentId: first.id, deliveryId: behind.deliveryId, waitMs: 400 }, connected);
  assert.ok(Date.now() - began >= 350, 'the wait took ' + (Date.now() - began) + ' ms');
  assert.deepEqual([still.settled, still.approvals.map(item => item.delegation), still.inputs], [false, [true], []]);
  await service.call('approval.cancel', { id: still.approvals[0].id }, connected);
  await assert.rejects(service.call('input.respond', { id: question.id, response: 'main' }, connected), { code: 'forbidden' });
  await service.call('input.respond', { id: question.id, response: 'main' }, local);
  await until(() => turns(instances).some(text => text.endsWith('I was told: "main"')), 'what the agent passed on for the owner');
  assert.deepEqual(await pending('approval'), [], 'nothing of the owner\'s own was asked about');
  // Full access: the owner's client may answer. Its answer is its text in a task that runs, on the owner's account:
  // the third way into a turn. It is not refused, since the owner chose that profile; but what the agent passes on
  // after it is passed on for a client, and waits for the owner's word.
  await service.call('access.update', { profile: 'full' }, local);
  await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Ask the client' }, local);
  await until(async () => (await pending('input')).length === 1, 'the second question');
  await service.call('operations.call', { operation: 'input.respond', input: { id: (await pending('input'))[0].id, response: 'whatever the client says' } }, connected);
  await until(async () => (await pending('approval')).length === 1, 'what the agent passes on after a client answered');
  const [relayed] = await pending('approval');
  assert.deepEqual([relayed.kind, relayed.agentId, relayed.details.task.endsWith('I was told: "whatever the client says"')], ['delegation', second.id, true]);
  assert.ok(!turns(instances).some(text => text.endsWith('I was told: "whatever the client says"')), 'and is not run before that');
  await answer(service, relayed.id, 'deny');
  // A permission the client grants is a choice among the agent's own options, not words of its own: it marks nothing.
  // What the agent passes on after it, in a task of the owner's, is the owner's still and is not asked about.
  factory.during = async (instance, text) => {
    if (instance !== builder) return;
    const granted = await instance.options.onApproval({ id: 'permission-' + text.length, kind: 'tool', summary: 'Run the tests', options: [{ optionId: 'proceed', name: 'Proceed' }, { optionId: 'stop', name: 'Stop' }] });
    service.agents.channelCall(token(instance), 'agent_send_message', { operationId: 'told-' + ++passed, recipientIds: [second.id], body: 'I was granted: ' + JSON.stringify(granted) });
  };
  await service.call('message.send', { ...scope, recipientIds: [first.id], body: 'Ask for a permission' }, local);
  await until(async () => (await pending('approval')).length === 1, 'the permission');
  const [permission] = await pending('approval');
  assert.notEqual(permission.kind, 'delegation');
  await service.call('operations.call', { operation: 'approval.resolve', input: { id: permission.id, optionId: 'proceed' } }, connected);
  await until(() => turns(instances).some(text => text.endsWith('I was granted: {"optionId":"proceed"}')), 'what the agent passed on after a client granted a permission');
  assert.deepEqual(await pending('approval'), [], 'a granted permission made nothing a client\'s');
});

test('devmate delegation shows and changes the choice', async () => {
  const output = () => { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; };
  let mode = 'ask', did = {};
  const calls = [];
  const clientFactory = () => ({ call: async (name, input) => { calls.push([name, input]); if (name === 'delegation.update') mode = input.mode; return { mode, ...(name === 'delegation.update' ? did : {}) }; } });
  const run = async args => { const stdout = output(), stderr = output(); return { code: await main(args, { stdout, stderr, clientFactory }), stdout: stdout.text, stderr: stderr.text }; };
  // A look at the choice says what it is, and nothing of what choosing it does to the tasks there are: it changed nothing.
  const ASK = 'Ask: a task that a connected client hands to Codex, Claude Code or another agent here waits until you allow it at this computer, in the workbench (devmate ui) or your editor. What you start here yourself is not asked about.';
  const shown = await run(['delegation']);
  assert.deepEqual([shown.stdout, calls.at(-1), shown.stderr], ['ask\n', ['delegation.read', {}], ASK + ' Not to be asked: devmate delegation allow\n']);
  // Choosing it says what it did, in numbers where there was something.
  const ALLOW = 'Allow: a connected client hands tasks to the coding agents here without asking you; each runs on your account with the provider.';
  const allowed = await run(['delegation', 'allow']);
  assert.deepEqual([allowed.code, allowed.stdout, calls.at(-1), allowed.stderr], [0, 'allow\n', ['delegation.update', { mode: 'allow' }], ALLOW + ' To be asked first: devmate delegation ask\n']);
  did = { allowed: 2, waiting: 1 };
  assert.equal((await run(['delegation', 'allow'])).stderr, ALLOW + ' 2 tasks that waited for your answer were let through. 1 task still waits: something else keeps it from beginning (no session is free, or the workflow is paused or has no turns left; ' +
    'the workbench says which, devmate ui), and it is let through when that is out of the way. To be asked first: devmate delegation ask\n');
  did = { allowed: 1, waiting: 3 };
  assert.equal((await run(['delegation', 'allow'])).stderr, ALLOW + ' 1 task that waited for your answer was let through. 3 tasks still wait: something else keeps them from beginning (no session is free, or the workflow is paused or has no turns left; ' +
    'the workbench says which, devmate ui), and they are let through when that is out of the way. To be asked first: devmate delegation ask\n');
  did = {};
  assert.equal((await run(['delegation', 'ask'])).stderr, ASK + ' From now on every agent is asked about again, also one whose later tasks you had let through. Not to be asked: devmate delegation allow\n');
  did = { again: 2 };
  assert.equal((await run(['delegation', 'ask'])).stderr, ASK + ' From now on every agent is asked about again, also one whose later tasks you had let through, and 2 tasks of a client that had been let through and had not begun wait for your answer again. Not to be asked: devmate delegation allow\n');
  // No more wait for the owner at once than may: what was beyond that is said as ended, not passed over.
  did = { again: 1, ended: 5 };
  assert.equal((await run(['delegation', 'ask'])).stderr, ASK + ' From now on every agent is asked about again, also one whose later tasks you had let through, and 1 task of a client that had been let through and had not begun waits for your answer again. ' +
    '5 more tasks of a client that had not begun were ended: as many as may wait for your answer at once did already. Not to be asked: devmate delegation allow\n');
  did = { ended: 1 };
  assert.equal((await run(['delegation', 'ask'])).stderr, ASK + ' From now on every agent is asked about again, also one whose later tasks you had let through. ' +
    '1 more task of a client that had not begun was ended: as many as may wait for your answer at once did already. Not to be asked: devmate delegation allow\n');
  did = {};
  assert.equal((await run(['delegation', 'off'])).stderr, 'Off: a connected client cannot hand tasks to the coding agents here; you still can, at this computer. What waited for your answer or its turn was ended. To be asked for each task instead: devmate delegation ask\n');
  assert.equal((await run(['delegation'])).stderr, 'Off: a connected client cannot hand tasks to the coding agents here; you still can, at this computer. To be asked for each task instead: devmate delegation ask\n');
  const wrong = await run(['delegation', 'never']);
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /delegation ask, delegation allow or delegation off/);
});

test('the owner\'s word for an agent goes with the session it was said of: a start that fails does not leave it behind', async t => {
  const { service, project, factory, instances, restart } = await fixture(t);
  // The owner says "this agent's later tasks too", and the agent cannot be started (not signed in with the provider).
  factory.failing = Object.assign(new Error('not signed in'), { code: 'agent_auth' });
  const first = await delegated(service, project, 'one');
  await answer(service, first.approvals[0].id, 'allow_agent');
  const failed = await service.call('agents.result', { agentId: first.agentId, deliveryId: first.deliveryId, waitMs: 5000 }, connected);
  assert.deepEqual([failed.settled, failed.status, failed.error.message, turns(instances)], [true, 'unavailable', 'not signed in', []]);
  // What was said of the session that never came to be is gone with it, where it is shown and where it counts.
  assert.deepEqual([service.store.get('agent', first.agentId).delegationAllowed, service.agents.sessions.has(first.agentId)], [false, false]);
  factory.failing = null;
  // Later the owner allows one more task of it, this one only: the agent starts, and that is all that was allowed.
  const second = await delegated(service, project, 'two', { agentId: first.agentId });
  assert.equal(second.approvals.length, 1);
  await answer(service, second.approvals[0].id, 'allow_once');
  assert.equal((await service.call('agents.result', { agentId: first.agentId, deliveryId: second.deliveryId, waitMs: 5000 }, connected)).output, 'done: two');
  const third = await delegated(service, project, 'three', { agentId: first.agentId });
  assert.deepEqual([third.settled, third.approvals.length, turns(instances)], [false, 1, ['two']], 'the next task is asked about');
  await assert.rejects(service.call('agents.steer', { id: first.agentId, body: 'x' }, connected), { code: 'delegation_ask' });
  await answer(service, third.approvals[0].id, 'deny');
  // Nor does the owner starting the agent by hand bring it back, or a record that says so by itself: it is the
  // session's, and a session begins without it.
  await service.call('agents.stop', { id: first.agentId }, local);
  service.store.update('agent', first.agentId, { delegationAllowed: true });
  await service.call('agents.resume', { id: first.agentId }, local);
  await until(() => service.store.get('agent', first.agentId).status === 'ready', 'the agent the owner resumed');
  const fourth = await delegated(service, project, 'four', { agentId: first.agentId });
  assert.deepEqual([fourth.approvals.length, turns(instances)], [1, ['two']]);
  // Choosing to be asked again takes what is shown off every agent, connected or not; so does a restart.
  await service.call('agents.stop', { id: first.agentId }, local);
  service.store.update('agent', first.agentId, { delegationAllowed: true });
  await service.call('delegation.update', { mode: 'ask' }, local);
  assert.equal(service.store.get('agent', first.agentId).delegationAllowed, false);
  service.store.update('agent', first.agentId, { delegationAllowed: true });
  assert.equal((await restart()).store.get('agent', first.agentId).delegationAllowed, false);
});

test('what waits for the owner ends with what it waited in: a project that is removed, a workflow that is completed, work that was discarded; and a copy made for a task that is not allowed goes with it', async t => {
  const { service, project, instances } = await fixture(t);
  const waitingNow = () => [...service.agents.decisions.values()].filter(decision => decision.consent).length;
  // A second project with tasks of a client waiting in it. Taking the project out of sharing (a client may: it
  // narrows) ends its questions; left standing, they would count against what may wait with nothing to show for it.
  const other = await service.call('project.create', { root: fs.mkdtempSync(path.join(path.dirname(project.root), 'second-')), name: 'Second' }, local);
  for (const name of ['a', 'b']) await service.call('agents.delegate', { projectId: other.id, provider: 'codex', prompt: name, waitMs: 1000 }, connected);
  assert.equal(waitingNow(), 2);
  await service.call('project.remove', { id: other.id }, connected);
  assert.equal(waitingNow(), 0);
  // A question whose task is gone by another way is not counted either: it is ended when the count is taken.
  const orphan = await delegated(service, project, 'orphan');
  service.store.remove('delivery', orphan.deliveryId);
  assert.equal(waitingNow(), 1);
  for (let count = 1; count <= 20; count++) await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'task ' + count, waitMs: 0 }, connected);
  assert.equal(waitingNow(), 20, 'twenty that really wait were taken');
  for (const item of (await service.call('approval.list', { projectId: project.id, status: 'pending' }, local)).items) await answer(service, item.id, 'deny');

  // A task waits for an agent in a workflow that the owner then completes: allowed, it could only fail. It ends.
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Done soon' }, local), scope = { projectId: project.id, workflowId: workflow.id };
  const agent = await service.call('agents.start', { ...scope, provider: 'codex' }, local);
  await until(() => service.store.get('agent', agent.id).status === 'ready', 'the agent');
  const late = await service.call('agents.delegate', { agentId: agent.id, prompt: 'too late', waitMs: 1000 }, connected);
  await service.call('workflow.update', { id: workflow.id, status: 'completed' }, local);
  assert.deepEqual([service.store.get('approval', late.approvals[0].id).status, service.store.get('delivery', late.deliveryId).status, service.store.get('delivery', late.deliveryId).error.code], ['expired', 'cancelled', 'workflow_inactive']);

  // A copy of the project is not made for a task that would only add to what the owner has not answered, and one
  // that was made for a task the owner then does not allow is removed with it. (The copy itself is a stand-in here.)
  const made = [], removed = [];
  service.workspace.isolate = async (_project, name) => { made.push(name); const root = path.join(path.dirname(project.root), name); fs.mkdirSync(root); return { root, branch: 'devmate/' + name, base: 'c0ffee', uncommitted: 0 }; };
  service.workspace.discardProposal = async (_project, copy) => { removed.push(copy.branch); return { discarded: true }; };
  const isolated = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'in a copy', isolate: true, waitMs: 1000 }, connected);
  assert.deepEqual([made.length, isolated.approvals.length, service.store.get('agent', isolated.agentId).isolated.branch], [1, 1, 'devmate/' + made[0]]);
  await answer(service, isolated.approvals[0].id, 'deny');
  await until(() => removed.length === 1, 'the copy to be removed');
  assert.deepEqual([removed, service.store.get('agent', isolated.agentId).status, service.store.get('agent', isolated.agentId).isolated.settled], [['devmate/' + made[0]], 'closed', 'discarded']);
  for (let count = 1; count <= 20; count++) await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'again ' + count, waitMs: 0 }, connected);
  await assert.rejects(service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'one too many', isolate: true, waitMs: 1000 }, connected), { code: 'delegation_backlog' });
  assert.equal(made.length, 1, 'no copy was made for the task that was refused');
  for (const item of (await service.call('approval.list', { projectId: project.id, status: 'pending' }, local)).items) await answer(service, item.id, 'deny');

  // Work of an agent in a copy that is discarded takes the question about its next task with it.
  const worker = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Mine, in a copy', isolate: true, waitMs: 20000 }, local);
  const next = await service.call('agents.delegate', { agentId: worker.agentId, prompt: 'and then this', waitMs: 1000 }, connected);
  assert.equal(next.approvals.length, 1);
  // (Its session has ended meanwhile, unused: the question outlasts that, as said above.)
  await service.agents.retire(worker.agentId, service.agents.sessions.get(worker.agentId), null);
  await service.call('agents.discard', { agentId: worker.agentId }, local);
  assert.deepEqual([service.store.get('approval', next.approvals[0].id).status, service.store.get('delivery', next.deliveryId).status, service.store.get('delivery', next.deliveryId).error.code], ['expired', 'cancelled', 'agent_finished']);
  assert.ok(!turns(instances).includes('and then this'));
});

test('a task that reaches an agent whose folder went while it was connected ends with that, said as that, before anything is spent on it; so does one for a copy that was deleted by hand', async t => {
  const { service, project, instances } = await fixture(t);
  const workflow = await service.call('workflow.create', { projectId: project.id, title: 'Connected' }, local), scope = { projectId: project.id, workflowId: workflow.id };
  // An agent that stays connected between its tasks, as for half an hour it does. (Claude Code runs one process for
  // each task, started in the project's folder every time.)
  const agent = await service.call('agents.start', { ...scope, provider: 'claude' }, local);
  await until(() => service.store.get('agent', agent.id).status === 'ready', 'the agent');
  const waiting = await service.call('agents.delegate', { agentId: agent.id, prompt: 'A client\'s', waitMs: 0 }, connected);
  const away = project.root + '-away';
  fs.renameSync(project.root, away);
  // The owner's message is taken in, since the agent is there, and ended before it is begun: nothing reaches the
  // provider, no turn stays counted, and the agent is as it was.
  const sent = await service.call('agents.send', { id: agent.id, body: 'Mine' }, local);
  await until(() => service.store.get('delivery', sent.deliveries[0].id).status === 'failed', 'the task to end');
  const ended = service.store.get('delivery', sent.deliveries[0].id).error;
  assert.equal(ended.code, 'project_missing'); assert.match(ended.message, /^The folder of this project is not there: /); assert.doesNotMatch(ended.message, /ENOENT|spawn/);
  assert.deepEqual([turns(instances), service.store.get('workflow', workflow.id).usedTurns, service.store.get('agent', agent.id).status, service.store.count('job', { projectId: project.id })], [[], 0, 'ready', 0]);
  // A yes for the client's task is not used up on it either: it is refused with the same words, and the question stays.
  await assert.rejects(answer(service, waiting.approvals[0].id, 'allow_once'), { code: 'project_missing', message: /^The folder of this project is not there: .* This task keeps waiting for your answer: allow it once that is out of the way, or refuse it\.$/ });
  assert.deepEqual([service.store.get('approval', waiting.approvals[0].id).status, service.store.get('delivery', waiting.deliveryId).status], ['pending', 'held']);
  // Where the owner chose not to be asked it waits, and says for what; and it goes by itself once the folder is back
  // (a drive that is connected again) and has been looked at, here by a list of the projects: nothing else changed.
  // The agent works on, with no start in between.
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 1 });
  assert.match(service.store.get('approval', waiting.approvals[0].id).waits, /^The folder of this project is not there: /);
  fs.renameSync(away, project.root);
  assert.equal((await service.call('project.list', {}, connected)).items[0].missing, undefined);
  assert.equal((await service.call('agents.result', { agentId: agent.id, deliveryId: waiting.deliveryId, waitMs: 5000 }, connected)).output, 'done: A client\'s');
  assert.deepEqual([service.store.get('approval', waiting.approvals[0].id).automatic, instances.length], [true, 1]);
  await service.call('delegation.update', { mode: 'ask' }, local);
  // Where the owner is asked, a folder that is back lets nothing through: the task is theirs to answer. And where
  // they are not, a call that goes through in the project is enough for the folder to be seen as back.
  const second = await service.call('agents.delegate', { agentId: agent.id, prompt: 'A second of the client\'s', waitMs: 0 }, connected);
  const still = () => [service.store.get('approval', second.approvals[0].id).status, service.store.get('delivery', second.deliveryId).status];
  fs.renameSync(project.root, away);
  await assert.rejects(answer(service, second.approvals[0].id, 'allow_once'), { code: 'project_missing' });
  fs.renameSync(away, project.root);
  await service.call('workspace.files', { projectId: project.id }, local);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(still(), ['pending', 'held']);
  fs.renameSync(project.root, away);
  assert.deepEqual(await service.call('delegation.update', { mode: 'allow' }, local), { mode: 'allow', waiting: 1 });
  fs.renameSync(away, project.root);
  await service.call('workspace.files', { projectId: project.id }, local);
  assert.equal((await service.call('agents.result', { agentId: agent.id, deliveryId: second.deliveryId, waitMs: 5000 }, connected)).output, 'done: A second of the client\'s');
  await service.call('delegation.update', { mode: 'ask' }, local);

  // An agent with a copy of its own works there. A copy that was deleted by hand is said as that, and what to do.
  service.workspace.isolate = async (_project, name) => { const root = path.join(path.dirname(project.root), name); fs.mkdirSync(root); return { root, branch: 'devmate/' + name, base: 'c0ffee', uncommitted: 0 }; };
  service.workspace.proposal = async () => ({ files: [] });
  const worker = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'In a copy', isolate: true, waitMs: 20000 }, local);
  assert.equal(worker.output, 'done: In a copy');
  const copy = service.store.get('agent', worker.agentId).isolated.root;
  fs.rmSync(copy, { recursive: true });
  const lost = await service.agents.delegate({ agentId: worker.agentId, prompt: 'More, in the copy', waitMs: 5000 }, { kind: 'user', id: 'owner', label: 'You' });
  // What it had committed is on the copy's branch in the repository, which discarding would delete: said, not hidden.
  const gone = 'The copy of the project this agent works in is not there any more: ' + copy + '. It was removed outside DevMate. What the agent had committed there is still on the branch ' +
    service.store.get('agent', worker.agentId).isolated.branch + ' of the project\'s repository; what it had not committed went with the folder. ' +
    'This agent cannot go on: start a new one for the next task. agents.discard takes its branch away as well, so look at the branch first if the work matters.';
  assert.deepEqual([lost.settled, lost.error.code, lost.error.message], [true, 'copy_missing', gone]);
  // A yes for a client's task for it is refused with that, and is not told to wait for what will not come.
  const late = await service.call('agents.delegate', { agentId: worker.agentId, prompt: 'A client\'s, in the copy', waitMs: 0 }, connected);
  await assert.rejects(answer(service, late.approvals[0].id, 'allow_once'), { code: 'copy_missing', message: gone + ' This task cannot begin with this agent any more: refuse it.' });
  await answer(service, late.approvals[0].id, 'deny');
  assert.deepEqual(turns(instances), ['A client\'s', 'A second of the client\'s', 'In a copy']);
});
