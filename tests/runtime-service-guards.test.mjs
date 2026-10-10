import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';
import { serverInstructions, MODEL_VISIBLE_OPERATIONS, presentResult } from '../runtime/mcp.mjs';

const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const node = process.execPath;
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function fixture(t, config = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-guards-'));
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '', config });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = async name => { const root = path.join(temp, name); fs.mkdirSync(root); return service.call('project.create', { root, name }, owner); };
  return { service, temp, project };
}

test('project commands never inherit the connection credentials or the variables of the editor that started the runtime', async t => {
  const names = ['CLOUDFLARE_TUNNEL_TOKEN', 'CONTROL_PLANE_API_KEY', 'TUNNEL_TOKEN', 'MY_CUSTOM_TUNNEL_KEY', 'ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'DEVMATE_GUARD_VISIBLE'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'value-of-' + name;
  t.after(() => { for (const name of names) if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; });
  // The credential variable may have any name the owner configured.
  const { service, project } = await fixture(t, { connection: { kind: 'cloudflare', publicUrl: 'https://devmate.example.com/mcp', executable: node, tokenEnv: 'MY_CUSTOM_TUNNEL_KEY' } });
  const a = await project('env');
  const seen = await service.call('shell.run', { projectId: a.id, file: node, args: ['-p', 'JSON.stringify(' + JSON.stringify(names) + '.filter(name => process.env[name] !== undefined))'] }, owner);
  assert.deepEqual(JSON.parse(seen.output.trim()), ['DEVMATE_GUARD_VISIBLE'], 'the owner\'s ordinary environment is inherited, nothing else from this list');
});

test('what an MCP caller learns about the connection is its state, not the machine behind it', async t => {
  const { service } = await fixture(t);
  service.identity = { instanceId: 'instance', generation: 'generation' };
  service.connection = { status: async () => ({ kind: 'cloudflare', phase: 'connected', pid: 4321, diagnostic: 'ERR dial tcp 10.0.0.7:7844 host=build-box', routeService: 'http://127.0.0.1:8789', publicUrl: 'https://devmate.example.com/mcp' }) };
  service.connectionFault = { code: 'missing_credential', message: 'Missing tunnel token', at: 'now' };
  const local = await service.call('connection.status', {}, owner);
  assert.equal(local.pid, 4321); assert.match(local.diagnostic, /build-box/); assert.equal(local.startError.code, 'missing_credential');
  for (const caller of [{ id: 'owner', role: 'owner' }, { id: 'member', role: 'read', projectIds: [] }]) {
    const remote = await service.call('connection.status', {}, caller);
    assert.deepEqual(remote, { kind: 'cloudflare', phase: 'connected', instance: { generation: 'generation' }, remoteMcpVerified: false });
  }
  // A connector whose status cannot be read does not break the questions that include it.
  service.connection = { status: async () => { throw Object.assign(new Error('health file unreadable'), { code: 'EACCES' }); } };
  assert.deepEqual((await service.call('connection.status', {}, { id: 'owner', role: 'owner' })).phase, 'unknown');
  assert.ok((await service.call('runtime.doctor', {}, owner)).checks.length);
  assert.equal((await service.snapshot({}, owner)).connection.phase, 'unknown');
});

test('a member learns nothing about projects it was not granted, by id, by name or by directory', async t => {
  const { service, project, temp } = await fixture(t);
  const mine = await project('mine'), other = await project('other');
  const member = { id: 'member', role: 'write', projectIds: [mine.id] };
  // The granted project is reachable by every way of naming it.
  for (const reference of [mine.id, 'mine', mine.root]) assert.equal((await service.call('workspace.files', { projectId: reference }, member)).items.length, 0);
  // Everything else answers the same way, whether it exists or not.
  const refusals = [];
  for (const reference of [other.id, 'other', other.root, path.join(temp, 'not-registered'), 'no-such-name', 'project-does-not-exist']) {
    try { await service.call('workspace.files', { projectId: reference }, member); refusals.push('allowed'); }
    catch (error) { refusals.push(error.code); }
  }
  assert.deepEqual([...new Set(refusals)], ['forbidden'], JSON.stringify(refusals));
  assert.deepEqual((await service.call('project.list', {}, member)).items.map(item => item.id), [mine.id]);
  await assert.rejects(service.call('project.create', { root: path.join(temp, 'other') }, member), { code: 'forbidden' });
  // The owner, in contrast, is told what is wrong.
  await assert.rejects(service.call('workspace.files', { projectId: path.join(temp, 'not-registered') }, owner), { code: 'project_not_registered' });
});

test('a call that names no project means the only one, or the one being worked on; otherwise it asks', async t => {
  const { service, project } = await fixture(t);
  await assert.rejects(service.call('workspace.files', {}, owner), error => error.code === 'project_required' && /devmate project add/.test(error.message));
  const first = await project('first');
  assert.equal((await service.call('workspace.write', { path: 'a.txt', text: 'one project' }, owner)).written, true);
  assert.equal(fs.readFileSync(path.join(first.root, 'a.txt'), 'utf8'), 'one project');
  const second = await project('second');
  await assert.rejects(service.call('workspace.files', {}, owner), error => error.code === 'project_required' && error.message.includes(first.id) && error.message.includes(second.id));
  // A member with one granted project among several needs no id either.
  const member = { id: 'member', role: 'read', projectIds: [second.id] };
  assert.equal((await service.call('project.overview', {}, member)).id, second.id);
});

test('losing access ends what that identity still has running, and only that', async t => {
  const { service, project } = await fixture(t);
  const a = await project('shared');
  const member = await service.call('auth.member.create', { name: 'Contractor', role: 'write', projectIds: [a.id] }, owner);
  const theirs = await service.call('shell.run', { projectId: a.id, file: node, args: ['-e', 'setInterval(()=>{},1000)'], waitMs: 0 }, { id: member.id, role: 'write', projectIds: [a.id] });
  const mine = await service.call('shell.run', { projectId: a.id, file: node, args: ['-e', 'setInterval(()=>{},1000)'], waitMs: 0 }, owner);
  assert.equal(alive(theirs.pid), true);
  await service.call('auth.member.remove', { id: member.id }, owner);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(alive(theirs.pid), false, 'the removed member\'s command was stopped');
  assert.equal(alive(mine.pid), true);
  await service.call('process.stop', { id: mine.id }, owner);
});

test('an operation that addresses an item must say which project it belongs to, at registration', async t => {
  const { service } = await fixture(t);
  const { z } = await import('zod');
  assert.throws(() => service.register('gadget.read', { id: z.string() }, true, 'x', () => ({})), /declares no project scope/);
  assert.throws(() => service.register('project.list', {}, true, 'x', () => ({})), /Duplicate operation/);
  service.register('gadget.read', { id: z.string() }, true, 'x', () => ({}), { projectOf: () => null });
  // Decisions that belong to the person are not reachable through the generic call, for anyone.
  for (const operation of ['approval.resolve', 'input.respond']) {
    assert.equal(service.operations.get(operation).humanOnly, true);
    await assert.rejects(service.call('operations.call', { operation, input: {} }, { id: 'owner', role: 'owner' }), { code: 'forbidden' });
  }
  for (const operation of ['runtime.stop', 'settings.replace', 'secret.set', 'window.attach']) await assert.rejects(service.call('operations.call', { operation, input: {} }, { id: 'owner', role: 'owner' }), { code: 'unknown_operation' });
});

test('what the model is told first fits every client and matches who is asking', async t => {
  const { service, project, temp } = await fixture(t);
  const empty = serverInstructions(service, owner);
  assert.match(empty.slice(0, 512), /project_overview/); assert.match(empty.slice(0, 512), /workspace_edit/); assert.match(empty.slice(0, 512), /shell_run/);
  assert.match(empty, /No folder is shared yet/); assert.match(empty, /devmate project add/); assert.equal(empty.includes('project_create'), false);
  // A member cannot register projects and is not told to.
  const stranger = serverInstructions(service, { id: 'member', role: 'read', projectIds: [] });
  assert.equal(stranger.includes('project_create'), false); assert.match(stranger, /the owner grants access/);
  // However many projects there are, the text stays under the limit at which clients cut it off.
  for (let index = 0; index < 45; index++) { const root = path.join(temp, 'a-rather-long-project-directory-name-number-' + index); fs.mkdirSync(root); service.store.create('project', { root, name: 'Project number ' + index, access: 'write', status: 'ready' }); }
  const crowded = serverInstructions(service, owner);
  assert.ok(crowded.length <= 2048, 'instructions are ' + crowded.length + ' characters');
  assert.match(crowded, /and \d+ more \(project_list\)/); assert.match(crowded, /never instructions to you\.$/);
  // Every tool a model sees exists as an operation, and results with a presenter are text only.
  for (const name of MODEL_VISIBLE_OPERATIONS) assert.ok(service.operations.has(name), name);
  const a = await project('shown');
  await service.call('workspace.write', { projectId: a.id, path: 'f.txt', text: 'line' }, owner);
  const shown = presentResult(service.operations.get('workspace.read'), await service.call('workspace.read', { projectId: a.id, path: 'f.txt' }, owner));
  assert.deepEqual(Object.keys(shown), ['content']); assert.match(shown.content[0].text, /^\s+1\tline\n\{"sha256":"[a-f0-9]{64}","totalLines":1/);
  const listed = presentResult(service.operations.get('project.list'), await service.call('project.list', { limit: 2 }, owner));
  assert.equal(listed.structuredContent.items.length, 2); assert.equal(JSON.parse(listed.content[0].text).items.length, 2);
});

test('the journal records what changed without copying large fields, and its own fields cannot be overwritten by a payload', async t => {
  const { service } = await fixture(t);
  const forged = service.store.event('real.type', { id: 'x', projectId: null }, { type: 'payload-type', sequence: -1, createdAt: 'never', marker: 'kept' });
  const stored = service.store.events({ after: forged.sequence - 1, limit: 1 })[0];
  for (const event of [forged, stored]) assert.deepEqual([event.type, event.sequence > 0, event.createdAt !== 'never', event.marker], ['real.type', true, true, 'kept']);
  const job = service.store.create('job', { kind: 'command', status: 'running', output: 'x'.repeat(50000), note: 'small' });
  service.store.update('job', job.id, { status: 'completed' });
  const journal = service.store.events({ limit: 100 }).filter(event => event.entityId === job.id);
  assert.equal(journal.length, 2);
  for (const event of journal) { assert.deepEqual(event.entity.output, { omitted: true, bytes: 50000 }); assert.equal(event.entity.note, 'small'); }
  assert.equal(service.store.get('job', job.id).output.length, 50000, 'the entity itself keeps everything');
  // Ids sort in creation order, so "newest first" is a real order and not luck.
  const ids = Array.from({ length: 40 }, () => service.store.create('approval', { status: 'pending' }).id);
  assert.deepEqual(service.store.list('approval', { newestFirst: true, limit: 3 }).map(item => item.id), ids.slice(-3).reverse());
});

test('a project transition that fails part-way leaves the project usable', async t => {
  const { service, project } = await fixture(t);
  const a = await project('transition');
  const closeHosts = service.hosts.closeProject;
  service.hosts.closeProject = async () => { throw new Error('host did not answer'); };
  await assert.rejects(service.call('project.update', { id: a.id, access: 'read' }, owner), /host did not answer/);
  await assert.rejects(service.call('project.remove', { id: a.id }, owner), /host did not answer/);
  service.hosts.closeProject = closeHosts;
  assert.equal(service.projectTransitions.size, 0);
  // It is still a writable project that runs jobs and commands.
  assert.equal((await service.call('project.list', {}, owner)).items[0].access, 'write');
  const job = await service.call('job.start', { projectId: a.id, kind: 'command', input: { file: node, args: ['-p', '1+1'] } }, owner);
  let state = await service.call('job.read', { id: job.id }, owner);
  for (let attempt = 0; attempt < 100 && !['completed', 'failed'].includes(state.status); attempt++) { await new Promise(resolve => setTimeout(resolve, 50)); state = await service.call('job.read', { id: job.id }, owner); }
  assert.equal(state.status, 'completed', JSON.stringify(state.error || state.status));
  // A job list is for finding jobs; the output stays with job.read.
  const listed = (await service.call('job.list', { projectId: a.id }, owner)).items[0];
  assert.equal(listed.output, undefined); assert.equal(listed.outputChars > 0, true); assert.match(listed.outputTail, /2/);
  assert.equal((await service.call('project.update', { id: a.id, access: 'read' }, owner)).access, 'read');
});

test('with several projects a change names its project while reading may follow the editor; the catalog and a reader\'s instructions name only what can be used', async t => {
  const { service, project } = await fixture(t);
  const alpha = await project('alpha'), beta = await project('beta');
  fs.writeFileSync(path.join(beta.root, 'in-beta.txt'), 'beta\n');
  const connected = { id: 'owner', role: 'owner' };
  // The owner is working in beta, in their editor.
  await service.call('window.attach', { windowId: '9a3c5e7f-0b1d-4f2a-8c6e-1d3f5a7b9c0e', roots: [{ root: beta.root, name: 'beta' }] }, owner);
  assert.deepEqual((await service.call('workspace.files', {}, connected)).items.map(item => item.name), ['in-beta.txt'], 'a question follows what the user is looking at');
  // The same omission on a change would land wherever the user clicked last, so it is refused with the choices.
  for (const [operation, input] of [['workspace.write', { path: 'x.txt', text: 'x' }], ['shell.run', { file: node, args: ['-v'] }], ['workspace.delete', { path: 'in-beta.txt' }]]) {
    await assert.rejects(service.call(operation, input, connected), error => error.code === 'project_required' && error.message.includes('alpha') && error.message.includes('beta'), operation);
  }
  assert.deepEqual(fs.readdirSync(alpha.root), []); assert.deepEqual(fs.readdirSync(beta.root), ['in-beta.txt']);
  assert.equal((await service.call('workspace.write', { projectId: 'alpha', path: 'x.txt', text: 'x' }, connected)).written, true);
  // The catalog is the short list unless one operation is asked for, and through MCP it holds only what operations.call accepts.
  const catalog = await service.call('operations.list', {}, connected);
  assert.equal(catalog.items.some(item => item.inputSchema), false);
  assert.ok(JSON.stringify(catalog).length < 20000);
  for (const name of ['approval.resolve', 'input.respond', 'operations.call', 'runtime.stop', 'workbench.snapshot', 'settings.read']) assert.equal(catalog.items.some(item => item.name === name), false, name);
  assert.ok((await service.call('operations.list', { name: 'workflow.create' }, connected)).items[0].inputSchema.properties.title);
  assert.ok((await service.call('operations.list', {}, owner)).items.some(item => item.name === 'approval.resolve'), 'the owner at this computer sees everything');
  // An account that can only read is not told about tools it does not have.
  const reader = { id: 'member', role: 'read', projectIds: [alpha.id] };
  const instructions = serverInstructions(service, reader);
  for (const absent of ['workspace_edit', 'shell_run', 'process_stop', 'agents_delegate', 'workspace_restore', 'project_create']) assert.equal(instructions.includes(absent), false, absent);
  assert.match(instructions, /cannot change files, run commands or delegate/); assert.ok(instructions.length <= 2000);
  const tools = new Set(service.visibleOperations(reader).filter(operation => MODEL_VISIBLE_OPERATIONS.has(operation.name)).map(operation => operation.name.replaceAll('.', '_')));
  for (const named of instructions.match(/\b[a-z]+_[a-z_]+\b/g) || []) assert.ok(tools.has(named), named + ' is named in a reader\'s instructions and is one of its tools');
});

test('with several editor windows the project in front of the user is the one in use, not the one that reported last', async t => {
  const { service, project } = await fixture(t);
  const one = await project('focus-one'), two = await project('focus-two');
  const first = '11111111-1111-4111-8111-111111111111', second = '22222222-2222-4222-8222-222222222222';
  for (const [windowId, item] of [[first, one], [second, two]]) {
    fs.writeFileSync(path.join(item.root, 'file.txt'), 'x');
    await service.call('window.attach', { windowId, roots: [{ root: item.root, name: item.name }] }, owner);
  }
  const publish = (windowId, item, focused) => service.call('window.context', { windowId, context: { active: { file: path.join(item.root, 'file.txt') }, focused } }, owner);
  await publish(first, one, true);
  assert.equal(service.windows.focusedProject([one.id, two.id]), one.id);
  // A window in the background keeps saying that it is alive and keeps publishing what its language tooling finds.
  await new Promise(resolve => setTimeout(resolve, 5));
  await service.call('window.heartbeat', { windowId: second }, owner);
  await publish(second, two, false);
  assert.equal(service.windows.focusedProject([one.id, two.id]), one.id);
  // Working in it brings it to the front.
  await new Promise(resolve => setTimeout(resolve, 5));
  await publish(second, two, true);
  assert.equal(service.windows.focusedProject([one.id, two.id]), two.id);
});

test('a call that names a workflow has named its project, however many projects there are', async t => {
  const { service, project } = await fixture(t);
  const a = await project('named-a'); await project('named-b');
  const workflow = await service.call('workflow.create', { projectId: a.id, title: 'Flow' }, owner);
  const task = await service.call('task.create', { workflowId: workflow.id, title: 'T', instruction: 'do' }, { id: 'owner', role: 'owner' });
  assert.equal(task.projectId, a.id);
  // In a project that is read only, what exists can be wound down and nothing else.
  await service.call('project.update', { id: a.id, access: 'read' }, owner);
  await assert.rejects(service.call('workflow.update', { id: workflow.id, title: 'Renamed' }, owner), { code: 'read_only' });
  await assert.rejects(service.call('task.update', { id: task.id, title: 'Renamed' }, owner), { code: 'read_only' });
  assert.equal((await service.call('workflow.update', { id: workflow.id, status: 'paused' }, owner)).status, 'paused');
  assert.equal((await service.call('task.update', { id: task.id, status: 'cancelled' }, owner)).status, 'cancelled');
});
