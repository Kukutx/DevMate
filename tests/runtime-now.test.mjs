import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';

// runtime.now: everything that is going on across all projects, for the owner at the computer.
const owner = Object.freeze({ id: 'owner', surface: 'local' }), connected = Object.freeze({ id: 'owner' });
async function runtimeWith(t, names) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-now-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await service.ready;
  const projects = [];
  for (const name of names) { const root = path.join(temp, name); fs.mkdirSync(root); projects.push(await service.call('project.create', { root, name }, owner)); }
  return { service, projects };
}

test('an idle runtime says so: nothing runs, nothing waits, nobody is attached', async t => {
  const { service, projects } = await runtimeWith(t, ['one']);
  const seen = await service.call('runtime.now', {}, owner);
  for (const kind of ['commands', 'jobs', 'agents', 'waiting']) assert.deepEqual(seen[kind], { items: [], total: 0 }, kind);
  assert.deepEqual(seen.projects, [{ id: projects[0].id, name: 'one', access: 'write' }]);
  assert.deepEqual(seen.windows, []);
  assert.equal(seen.browser.connected, false);
  assert.equal(seen.client, null);
  assert.deepEqual(seen.runtime, { version: seen.runtime.version, access: 'guarded', delegation: 'ask' });
  assert.equal(seen.connection.kind, 'local');
  assert.ok(Date.parse(seen.updatedAt) > 0);
});

test('what runs and what waits is listed across every project, each with what stops it, and with no more of its text than names it', async t => {
  const { service, projects } = await runtimeWith(t, ['one', 'two']);
  const [one, two] = projects.map(project => project.id);
  // A command that keeps running in each project, and one that has ended.
  const sleeper = { file: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], waitMs: 0 };
  const first = await service.call('shell.run', { projectId: one, ...sleeper }, owner), second = await service.call('shell.run', { projectId: two, ...sleeper }, owner);
  await service.call('shell.run', { projectId: one, file: process.execPath, args: ['-e', '0'], waitMs: 20000 }, owner);
  // What the registries hold of agents, jobs and questions, in the states that count as going on and in those that do not.
  const long = 'a task whose words go on '.repeat(40);
  const working = service.store.create('agent', { projectId: one, provider: 'codex', label: 'working\n  on it', status: 'running', capabilities: {}, error: null, client: true });
  service.store.create('agent', { projectId: two, provider: 'claude', label: 'gone', status: 'closed', capabilities: {}, error: null });
  service.store.create('agent', { projectId: two, provider: 'claude', label: 'not begun', status: 'unstarted', capabilities: {}, error: null });
  const asked = service.store.create('approval', { projectId: two, agentId: working.id, kind: 'delegation', status: 'pending', summary: long, options: [] });
  service.store.create('approval', { projectId: one, agentId: working.id, kind: 'command', status: 'resolved', summary: 'decided', options: [] });
  const question = service.store.create('input', { projectId: one, source: 'mcp', kind: 'elicitation', status: 'pending', prompt: 'Which one?', details: {} });
  const queued = service.store.create('job', { projectId: two, kind: 'capability', status: 'queued', input: { args: { capability: 'chrome.tabs.list', env: { SECRET: 'kept-out' } } } });
  service.store.create('job', { projectId: two, kind: 'command', status: 'completed', input: { args: { command: 'echo done' } } });
  const turn = service.store.create('job', { projectId: one, kind: 'agent-turn', status: 'running', agentId: working.id, input: {} });

  const seen = await service.call('runtime.now', {}, owner);
  assert.deepEqual(seen.commands.items.map(item => [item.id, item.projectId]).sort(), [[first.id, one], [second.id, two]].sort());
  assert.equal(seen.commands.total, 2);
  assert.ok(seen.commands.items.every(item => typeof item.command === 'string' && item.command.length <= 201 && Date.parse(item.startedAt) > 0));
  assert.deepEqual(seen.agents, { items: [{ id: working.id, projectId: one, label: 'working on it', provider: 'codex', status: 'running', client: true }], total: 1 });
  assert.deepEqual(seen.waiting.items.map(item => [item.id, item.asks, item.projectId]), [[asked.id, 'approval', two], [question.id, 'input', one]]);
  assert.equal(seen.waiting.items[0].summary.length, 201, 'the beginning of a long text, and a mark that it goes on');
  assert.ok(seen.waiting.items[0].summary.endsWith('…'));
  assert.equal(seen.waiting.items[1].summary, 'Which one?');
  assert.deepEqual([seen.waiting.items[0].agent, seen.waiting.items[0].agentId, 'agent' in seen.waiting.items[1]], ['working on it', working.id, false], 'who asks is named as the agent is called');
  assert.deepEqual(seen.jobs.items.map(item => [item.id, item.kind, item.status, item.what, item.agentId]).sort(), [[queued.id, 'capability', 'queued', 'chrome.tabs.list', undefined], [turn.id, 'agent-turn', 'running', '', working.id]].sort());
  assert.equal(JSON.stringify(seen).includes('kept-out'), false, 'the value of a variable a job was given is not in it');

  // What is stopped with the operation that has always stopped it is gone from the next answer.
  await service.call('process.stop', { id: first.id }, owner);
  await service.call('process.stop', { id: second.id }, owner);
  assert.deepEqual((await service.call('runtime.now', {}, owner)).commands, { items: [], total: 0 });
});

test('the whole picture is the owner\'s at the computer: a connected client is neither shown the operation nor answered, in either profile', async t => {
  const { service } = await runtimeWith(t, ['one']);
  const operation = service.operations.get('runtime.now');
  assert.equal(operation.localOnly, true);
  assert.equal(operation.readOnly, true);
  for (const profile of ['guarded', 'full']) {
    service.setAccessProfile(profile);
    assert.equal(service.visibleOperations(connected).some(item => item.name === 'runtime.now'), false, profile);
    await assert.rejects(service.call('runtime.now', {}, connected), { code: 'forbidden' }, profile);
    await assert.rejects(service.call('operations.query', { operation: 'runtime.now' }, connected), error => ['forbidden', 'unknown_operation'].includes(error.code), profile);
  }
  assert.equal(service.visibleOperations(owner).some(item => item.name === 'runtime.now'), true);
});

test('a project that was taken off the list takes its entries with it, and an editor window and the last client are named', async t => {
  const { service, projects } = await runtimeWith(t, ['one', 'two']);
  service.store.create('approval', { projectId: projects[1].id, kind: 'command', status: 'pending', summary: 'of the second project', options: [] });
  service.lastClient = { name: 'a client', userAgent: 'agent/1', surface: 'gpt', tunnel: false, at: '2026-10-12T10:00:00.000Z' };
  assert.equal((await service.call('runtime.now', {}, owner)).waiting.total, 1);
  await service.call('project.remove', { id: projects[1].id }, owner);
  const seen = await service.call('runtime.now', {}, owner);
  assert.equal(seen.waiting.total, 0);
  assert.deepEqual(seen.projects.map(project => project.name), ['one']);
  assert.deepEqual(seen.client, { name: 'a client', userAgent: 'agent/1', surface: 'gpt', tunnel: false, at: '2026-10-12T10:00:00.000Z' });
});
