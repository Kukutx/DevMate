import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DevMateService } from '../runtime/service.mjs';
import { VERIFY_CLIENT } from '../runtime/connection-verify.mjs';

// Who did it: every call that changes something leaves one line in the journal, and the clients are remembered.
const owner = Object.freeze({ id: 'owner', surface: 'local' });
const client = (name, via = 'address') => ({ id: 'owner', via, ...(name === undefined ? {} : { client: name }) });
async function runtimeWith(t, names = ['one']) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-callers-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await service.ready;
  const projects = [];
  for (const name of names) { const root = path.join(temp, name); fs.mkdirSync(root); projects.push(await service.call('project.create', { root, name }, owner)); }
  const notes = () => service.store.recentEvents({ type: 'operation.called', limit: 500 });
  return { service, projects, notes, temp };
}

test('a change is noted with who asked for it, by which way, and whether it went through; what it carried is not', async t => {
  const { service, projects, notes } = await runtimeWith(t), [project] = projects;
  assert.deepEqual(notes().map(note => [note.operation, note.by, note.ok, note.projectId]), [['project.create', { surface: 'local' }, true, null]], 'the owner sharing a folder at the computer');
  const secret = 'the-words-of-the-file-' + 'x'.repeat(40);
  await service.call('workspace.write', { projectId: project.id, path: 'note.md', text: secret }, client('ChatGPT'));
  await service.call('workspace.write', { projectId: project.id, path: 'other.md', text: 'two' }, { ...client('Claude', 'openai-tunnel') });
  await service.call('workspace.write', { projectId: project.id, path: 'third.md', text: 'three' }, { id: 'owner', surface: 'local', windowId: randomUUID(), projectId: project.id });
  const [, first, second, third] = notes();
  assert.deepEqual([first.operation, first.by, first.ok, first.projectId], ['workspace.write', { surface: 'connected', via: 'address', client: 'ChatGPT' }, true, project.id]);
  assert.deepEqual(second.by, { surface: 'connected', via: 'openai-tunnel', client: 'Claude' });
  assert.deepEqual(third.by, { surface: 'local', window: true });
  assert.ok(Number.isInteger(first.ms) && first.ms >= 0);
  // Nothing of what the call carried: not the words, not the path.
  const kept = JSON.stringify(notes());
  for (const part of [secret, 'note.md', 'other.md']) assert.equal(kept.includes(part), false, part);
  assert.deepEqual(Object.keys(first).sort(), ['by', 'createdAt', 'entityId', 'ms', 'ok', 'operation', 'projectId', 'sequence', 'type', 'workflowId'].sort());
  // It is among the events of its project, where a client that works there can read them; what belongs to no project is not.
  const listed = (await service.call('event.list', { projectId: project.id, latest: true, limit: 100 }, client('ChatGPT'))).items.filter(item => item.type === 'operation.called');
  assert.deepEqual(listed.map(item => item.operation), ['workspace.write', 'workspace.write', 'workspace.write']);
});

test('a call that fails is noted with its code and without its message; one that only reads, and what a host asks in the background, are not noted', async t => {
  const { service, projects, notes } = await runtimeWith(t), [project] = projects, before = notes().length;
  await assert.rejects(service.call('workspace.write', { projectId: project.id, path: '../outside.md', text: 'x' }, client('ChatGPT')));
  // A decision that is the owner's, asked for by a client: refused, and the attempt is on record.
  await assert.rejects(service.call('access.update', { profile: 'full' }, client('ChatGPT')), { code: 'forbidden' });
  const [escaped, forbidden] = notes().slice(before);
  assert.equal(escaped.ok, false);
  assert.ok(typeof escaped.code === 'string' && escaped.code.length > 0 && !('message' in escaped));
  assert.deepEqual([forbidden.operation, forbidden.ok, forbidden.code, forbidden.projectId], ['access.update', false, 'forbidden', null]);
  const count = notes().length;
  await service.call('project.list', {}, client('ChatGPT'));
  await service.call('workspace.read', { projectId: project.id, path: 'missing.md' }, client('ChatGPT')).catch(() => {});
  const quiet = randomUUID();
  await service.call('window.attach', { windowId: quiet, title: 'Editor', roots: [{ root: project.root, name: 'one' }] }, owner);
  await service.call('window.context', { windowId: quiet, context: { diagnostics: [] } }, owner);
  await service.call('window.detach', { windowId: quiet }, owner);
  await service.call('host.record.put', { key: 'k', value: { a: 1 } }, owner).catch(() => {});
  // The generic call is not noted as itself: its target is, once.
  await service.call('operations.call', { operation: 'workspace.write', input: { projectId: project.id, path: 'via-generic.md', text: 'x' } }, client('ChatGPT'));
  assert.deepEqual(notes().slice(count).map(note => note.operation), ['workspace.write']);
  // An operation that does not exist is no operation to note.
  await assert.rejects(service.call('no.such.operation', {}, client('ChatGPT')));
  assert.equal(notes().length, count + 1);
});

test('the clients since the runtime started are remembered by name and way, newest last, a few of them, and the runtime\'s own check of its route is not one', async t => {
  const { service, projects } = await runtimeWith(t), [project] = projects;
  assert.equal(service.clients.size, 0, 'the owner at the computer is no client');
  await service.call('project.list', {}, client('ChatGPT'));
  await service.call('workspace.write', { projectId: project.id, path: 'a.md', text: 'a' }, client('ChatGPT'));
  await service.call('project.list', {}, client('ChatGPT', 'openai-tunnel'));
  await service.call('project.list', {}, client(undefined, 'local'));
  const seen = [...service.clients.values()];
  assert.deepEqual(seen.map(item => [item.name, item.via, item.calls, item.changes, item.lastOperation]), [['ChatGPT', 'address', 2, 1, 'workspace.write'], ['ChatGPT', 'openai-tunnel', 1, 0, 'project.list'], ['', 'local', 1, 0, 'project.list']]);
  assert.ok(seen.every(item => Date.parse(item.firstAt) > 0 && Date.parse(item.lastAt) >= Date.parse(item.firstAt)));
  // Asking again moves a client to the end and keeps when it was first seen.
  await service.call('project.list', {}, client('ChatGPT'));
  assert.deepEqual([...service.clients.values()].map(item => item.name + '/' + item.via).at(-1), 'ChatGPT/address');
  assert.equal([...service.clients.values()].at(-1).firstAt, seen[0].firstAt);
  // The route check asks one question under its own name and is passed over; anything else under that name is noted.
  await service.call('connection.status', {}, client(VERIFY_CLIENT));
  assert.equal([...service.clients.values()].some(item => item.name === VERIFY_CLIENT), false);
  await service.call('project.list', {}, client(VERIFY_CLIENT));
  assert.equal([...service.clients.values()].at(-1).name, VERIFY_CLIENT);
  // No more than a few are kept: the oldest go.
  for (let index = 0; index < 30; index++) await service.call('project.list', {}, client('client-' + index));
  assert.equal(service.clients.size, 20);
  assert.equal([...service.clients.values()].some(item => item.name === 'ChatGPT'), false);
  assert.equal([...service.clients.values()].at(-1).name, 'client-29');
});

test('the page of everything that is going on is given the clients and the last changes, newest first, with the project of each', async t => {
  const { service, projects } = await runtimeWith(t, ['one', 'two']);
  await service.call('workspace.write', { projectId: projects[0].id, path: 'a.md', text: 'a' }, client('ChatGPT'));
  await assert.rejects(service.call('capability.call', { projectId: projects[1].id, capability: 'no.such.capability', input: {} }, client('Claude', 'local')));
  const seen = await service.call('runtime.now', {}, owner);
  assert.deepEqual(seen.clients.map(item => [item.name, item.via]), [['Claude', 'local'], ['ChatGPT', 'address']]);
  assert.deepEqual(seen.changes.slice(0, 2).map(item => [item.operation, item.by.client, item.ok, item.projectId, item.what]),
    [['capability.call', 'Claude', false, projects[1].id, 'no.such.capability'], ['workspace.write', 'ChatGPT', true, projects[0].id, undefined]]);
  assert.ok(seen.changes.every(item => Date.parse(item.at) > 0 && Number.isInteger(item.sequence)));
  assert.equal(seen.changes.at(-1).operation, 'project.create', 'the oldest is last');
  // No more than the last fifty.
  for (let index = 0; index < 60; index++) await service.call('workspace.write', { projectId: projects[0].id, path: 'many-' + index + '.md', text: String(index) }, client('ChatGPT'));
  assert.equal((await service.call('runtime.now', {}, owner)).changes.length, 50);
});

test('a call that is handed on by name is noted and counted once, as the operation it was handed to; one that came to nothing is noted as itself, with the name that was asked for', async t => {
  const { service, projects, notes } = await runtimeWith(t), [project] = projects, before = notes().length, who = client('ChatGPT');
  const counted = () => { const [one] = [...service.clients.values()]; return [one.calls, one.changes, one.lastOperation]; };
  await service.call('operations.call', { operation: 'workspace.write', input: { projectId: project.id, path: 'handed-on.md', text: 'x' } }, who);
  assert.deepEqual(counted(), [1, 1, 'workspace.write']);
  await service.call('operations.query', { operation: 'project.list' }, who);
  assert.deepEqual(counted(), [2, 1, 'project.list'], 'what only reads is one call and no change');
  // The target ran and failed: its own line, and no second one for the call that handed it on.
  await assert.rejects(service.call('operations.call', { operation: 'workspace.write', input: { projectId: project.id, path: '../outside.md', text: 'x' } }, who));
  assert.deepEqual(counted(), [3, 1, 'workspace.write'], 'a call that failed changed nothing');
  // It never came to a target: an operation that is the owner's alone at the computer, asked for by name.
  await assert.rejects(service.call('operations.call', { operation: 'access.update', input: { profile: 'full' } }, who), { code: 'unknown_operation' });
  assert.deepEqual(counted(), [4, 1, 'operations.call']);
  await assert.rejects(service.call('operations.query', { operation: 'workspace.write' }, who), { code: 'forbidden' });
  assert.deepEqual(counted(), [5, 1, 'operations.query']);
  assert.deepEqual(notes().slice(before).map(note => [note.operation, note.ok, note.code, note.what]),
    [['workspace.write', true, undefined, undefined], ['workspace.write', false, notes().at(-2).code, undefined], ['operations.call', false, 'unknown_operation', 'access.update']]);
  // The name that was asked for is a client's text: kept short and printable.
  await assert.rejects(service.call('operations.call', { operation: 'no.such\u0007.thing-' + 'x'.repeat(90) }, who));
  assert.equal(notes().at(-1).what, ('no.such.thing-' + 'x'.repeat(90)).slice(0, 80));
});
