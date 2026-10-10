import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult, serverInstructions } from '../runtime/mcp.mjs';
import { callWorkbenchTool } from '../runtime/workbench.mjs';
import { main } from '../runtime/cli.mjs';

// The owner at this computer, the same owner reached through MCP, and a signed-in member.
const local = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const connected = Object.freeze({ id: 'owner', role: 'owner', projectIds: null });
const ALLOW_DENY = [{ optionId: 'allow', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }];

// A native adapter stand-in whose every turn asks what `asks` lists, in order, before it finishes.
function adapters() {
  const instances = [];
  const factory = options => {
    const instance = { options, answers: [], capabilities: { steer: false, approvals: true, mcp: true },
      async start() { return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
      async send({ text }) {
        instance.controller = new AbortController();
        try {
          for (const [kind, request] of factory.asks || [])
            instance.answers.push(await options[kind === 'input' ? 'onInput' : 'onApproval']({ id: 'native-' + instance.answers.length, details: {}, native: {}, ...request }, { signal: instance.controller.signal }));
        } catch { return { status: 'interrupted' }; }
        return { status: 'completed', text: 'done: ' + text, native: {} };
      },
      async cancel() { instance.controller?.abort(); return { requested: true }; },
      async close() { instance.controller?.abort(); }
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}

async function fixture(t) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-access-')));
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
  const folder = (...names) => { const root = path.join(temp, ...names); fs.mkdirSync(root, { recursive: true }); return root; };
  return { service, folder, factory, instances, restart: open };
}
const offered = (service, context) => service.visibleOperations(context).map(operation => operation.name);

test('guarded is the default, and only the owner at this computer chooses the profile', async t => {
  const { service, restart } = await fixture(t);
  assert.deepEqual(await service.call('access.read', {}, connected), { profile: 'guarded' });
  await assert.rejects(service.call('access.update', { profile: 'full' }, connected), { code: 'forbidden', message: /local control interface/ });
  await assert.rejects(service.call('operations.call', { operation: 'access.update', input: { profile: 'full' } }, connected), { code: 'unknown_operation' });
  await assert.rejects(service.call('access.update', { profile: 'everything' }, local), { code: 'invalid_input' });
  assert.equal(offered(service, connected).includes('access.update'), false);
  assert.equal(offered(service, connected).includes('access.read'), true);
  assert.deepEqual(await service.call('access.update', { profile: 'full' }, local), { profile: 'full' });
  assert.deepEqual(await service.call('access.read', {}, connected), { profile: 'full' });
  // The choice is the instance's own: it is still there after a restart.
  const again = await restart();
  assert.equal(again.fullAccess(), true);
  assert.deepEqual(await again.call('access.update', { profile: 'guarded' }, local), { profile: 'guarded' });
  assert.equal(again.fullAccess(), false);
});

test('full access hands the owner\'s decisions to the owner\'s connected client, and guarded takes them back', async t => {
  const { service, folder } = await fixture(t);
  const app = folder('workspace', 'app');
  fs.writeFileSync(path.join(app, '.env'), 'TOKEN=protected-value\n');
  const project = await service.call('project.create', { root: app, access: 'read' }, local);
  const refused = async () => {
    await assert.rejects(service.call('project.create', { root: folder('elsewhere') }, connected), { code: 'forbidden', message: /devmate access full/ });
    await assert.rejects(callWorkbenchTool('workbench_call', { operation: 'project.create', input: { root: folder('elsewhere') } }, service, connected), { code: 'forbidden' });
    await assert.rejects(service.call('project.update', { id: project.id, access: 'write' }, connected), { code: 'forbidden' });
    await assert.rejects(service.call('workspace.read', { projectId: project.id, path: '.env' }, connected), { code: 'protected_workspace_path' });
    await assert.rejects(service.call('capability.configure', { engine: 'godot', settings: { enabled: true } }, connected), { code: 'forbidden' });
    for (const name of ['project.create', 'approval.resolve', 'input.respond']) assert.equal(offered(service, connected).includes(name), false, name);
    assert.doesNotMatch(serverInstructions(service, connected), /full access/);
  };
  await refused();

  await service.call('access.update', { profile: 'full' }, local);
  for (const name of ['project.create', 'approval.resolve', 'input.respond']) assert.equal(offered(service, connected).includes(name), true, name);
  const listed = (await service.call('operations.list', {}, connected)).items.map(item => item.name);
  for (const name of ['project.create', 'approval.resolve', 'input.respond']) assert.equal(listed.includes(name), true, name);
  // Sharing a folder, also through the generic call a model uses and through an embedded workbench.
  const shared = await service.call('operations.call', { operation: 'project.create', input: { root: folder('elsewhere'), name: 'Elsewhere' } }, connected);
  assert.equal(shared.name, 'Elsewhere');
  assert.equal((await callWorkbenchTool('workbench_call', { operation: 'project.create', input: { root: folder('third') } }, service, connected)).structuredContent.name, 'third');
  // Widening, and credential files: nothing is withheld, whatever the project's own setting says.
  assert.equal((await service.call('project.update', { id: project.id, access: 'write' }, connected)).access, 'write');
  assert.equal(service.store.get('project', project.id).protectSecrets, true, 'the project keeps its own setting');
  assert.equal((await service.call('workspace.read', { projectId: project.id, path: '.env' }, connected)).text, 'TOKEN=protected-value\n');
  assert.ok((await service.call('workspace.files', { projectId: project.id }, connected)).items.some(item => item.name === '.env'));
  await service.call('capability.configure', { engine: 'godot', settings: { enabled: true } }, connected);
  // One switch stays at the computer in either profile: the memory of other processes.
  for (const key of ['allowProcessAccess', 'allowMemoryWrite'])
    await assert.rejects(service.call('capability.configure', { engine: 'reverse', settings: { [key]: true } }, connected), { code: 'forbidden', message: /memory of other processes/ });
  await service.call('capability.configure', { engine: 'reverse', settings: { allowProcessAccess: true } }, local);
  assert.equal((await service.call('capability.settings', { engine: 'reverse' }, local)).items[0].settings.allowProcessAccess, true);
  await service.call('capability.configure', { engine: 'reverse', settings: { allowProcessAccess: null } }, local);
  // The editor's state follows: an open credential file is part of what the owner has in front of them.
  const windowId = randomUUID();
  await service.call('window.attach', { windowId, title: 'Fixture', roots: [{ root: app, name: 'app' }] }, { ...local, windowId });
  const publish = () => service.call('window.context', { windowId, context: { active: { file: path.join(app, '.env'), languageId: 'dotenv', lineCount: 1 } } }, { ...local, windowId });
  await publish();
  assert.equal((await service.call('editor.context', { projectId: project.id }, connected)).active.path, '.env');
  const told = serverInstructions(service, connected);
  assert.match(told, /full access/); assert.match(told, /project\.create/); assert.ok(told.length <= 2000, 'the instructions stay within what clients read');

  // Full access is the owner's. An account the owner invited keeps exactly its grants.
  const member = { id: 'member-1', role: 'write', projectIds: [project.id] };
  await assert.rejects(service.call('project.create', { root: folder('members') }, member), { code: 'forbidden' });
  for (const name of ['project.create', 'approval.resolve', 'input.respond']) assert.equal(offered(service, member).includes(name), false, name);
  assert.doesNotMatch(serverInstructions(service, member), /full access/);

  await service.call('access.update', { profile: 'guarded' }, local);
  await service.call('project.update', { id: project.id, access: 'read' }, local);
  await refused();
  await publish();
  assert.equal((await service.call('editor.context', { projectId: project.id }, connected)).active, null);
});

test('with full access what a delegated agent asks permission for is granted at once and stays on record', async t => {
  const { service, folder, factory, instances } = await fixture(t);
  const project = await service.call('project.create', { root: folder('project') }, local);
  await service.call('access.update', { profile: 'full' }, local);
  // Claude and Codex name the granting option; ACP agents say which of theirs grants once.
  factory.asks = [
    ['approval', { kind: 'Write', options: ALLOW_DENY }],
    ['approval', { kind: 'command', options: [['accept', 'Allow once'], ['acceptForSession', 'Allow for this session'], ['decline', 'Deny']].map(([optionId, name]) => ({ optionId, name })) }],
    ['approval', { kind: 'tool', options: [{ optionId: 'r', name: 'No', kind: 'reject_once' }, { optionId: 'a', name: 'Always', kind: 'allow_always' }, { optionId: 'o', name: 'Yes', kind: 'allow_once' }] }],
    ['approval', { kind: 'tool', options: [{ optionId: 'r', name: 'No', kind: 'reject_once' }, { optionId: 'a', name: 'Always', kind: 'allow_always' }] }]
  ];
  const started = Date.now();
  const done = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Write a file', waitMs: 20000 }, connected);
  assert.equal(done.settled, true); assert.equal(done.output, 'done: Write a file'); assert.deepEqual(done.approvals, []);
  assert.ok(Date.now() - started < 5000, 'nothing waited for a person');
  assert.deepEqual(instances[0].answers, [{ optionId: 'allow' }, { optionId: 'accept' }, { optionId: 'o' }, { optionId: 'a' }]);
  const records = (await service.call('approval.list', { projectId: project.id }, connected)).items;
  assert.deepEqual(records.map(item => [item.status, item.automatic, item.answer.optionId]), [['resolved', true, 'allow'], ['resolved', true, 'accept'], ['resolved', true, 'o'], ['resolved', true, 'a']]);
});

test('a question, and a permission with nothing to grant, still wait; the owner\'s client may answer them with full access only', async t => {
  const { service, folder, factory, instances } = await fixture(t);
  const project = await service.call('project.create', { root: folder('project') }, local);
  await service.call('access.update', { profile: 'full' }, local);
  factory.asks = [['approval', { kind: 'tool', options: [{ optionId: 'no', name: 'Refuse' }, { optionId: 'stop', name: 'Stop' }] }], ['input', { kind: 'question', summary: 'Which branch?' }]];
  const blocked = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Ask first', waitMs: 20000 }, connected);
  assert.equal(blocked.status, 'waiting'); assert.equal(blocked.approvals.length, 1);
  assert.match(presentResult(service.operations.get('agents.delegate'), blocked).content[0].text, /operations_call \(approval\.resolve/);
  // Back in the guarded profile the same client is refused, directly and through the generic call.
  await service.call('access.update', { profile: 'guarded' }, local);
  await assert.rejects(service.call('approval.resolve', { id: blocked.approvals[0].id, optionId: 'no' }, connected), { code: 'forbidden', message: /user's own/ });
  await assert.rejects(service.call('operations.call', { operation: 'approval.resolve', input: { id: blocked.approvals[0].id, optionId: 'no' } }, connected), { code: 'forbidden' });
  assert.match(presentResult(service.operations.get('agents.result'), await service.call('agents.result', { agentId: blocked.agentId }, connected)).content[0].text, /await the user in the DevMate workbench/);
  await service.call('access.update', { profile: 'full' }, local);
  await service.call('operations.call', { operation: 'approval.resolve', input: { id: blocked.approvals[0].id, optionId: 'no' } }, connected);
  const asked = await service.call('agents.result', { agentId: blocked.agentId, waitMs: 5000 }, connected);
  assert.deepEqual(asked.inputs.map(item => item.summary), ['Which branch?']);
  await service.call('input.respond', { id: asked.inputs[0].id, response: { answer: 'main' } }, connected);
  const done = await service.call('agents.result', { agentId: blocked.agentId, waitMs: 5000 }, connected);
  assert.equal(done.settled, true);
  assert.deepEqual(instances[0].answers, [{ optionId: 'no' }, { answer: 'main' }]);
  assert.equal(service.store.get('approval', blocked.approvals[0].id).automatic, undefined, 'a person\'s answer is not marked automatic');
});

test('choosing full access grants the permission an agent is already waiting for', async t => {
  const { service, folder, factory } = await fixture(t);
  const project = await service.call('project.create', { root: folder('project') }, local);
  factory.asks = [['approval', { kind: 'Write', options: ALLOW_DENY }]];
  const blocked = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Write a file', waitMs: 20000 }, connected);
  assert.equal(blocked.status, 'waiting');
  await service.call('access.update', { profile: 'full' }, local);
  const done = await service.call('agents.result', { agentId: blocked.agentId, waitMs: 5000 }, connected);
  assert.equal(done.settled, true); assert.equal(done.output, 'done: Write a file');
  const record = service.store.get('approval', blocked.approvals[0].id);
  assert.deepEqual([record.status, record.automatic, record.answer.optionId], ['resolved', true, 'allow']);
});

test('the doctor and the workbench say which profile is on', async t => {
  const { service } = await fixture(t);
  const access = async () => (await service.call('runtime.doctor', {}, local)).checks.find(item => item.id === 'access');
  assert.equal((await access()).status, 'ok');
  assert.equal((await service.call('workbench.snapshot', {}, connected)).access.profile, 'guarded');
  await service.call('access.update', { profile: 'full' }, local);
  const check = await access();
  assert.equal(check.status, 'info'); assert.match(check.detail, /Full access/); assert.match(check.fix, /devmate access guarded/);
  assert.equal((await service.call('workbench.snapshot', {}, connected)).access.profile, 'full');
});

test('devmate access shows and changes the profile', async () => {
  const output = () => { let text = ''; return { write(value) { text += value; }, get text() { return text; } }; };
  let profile = 'guarded';
  const calls = [];
  const clientFactory = () => ({ call: async (name, input) => { calls.push([name, input]); if (name === 'access.update') profile = input.profile; return { profile }; } });
  const run = async args => { const stdout = output(), stderr = output(); return { code: await main(args, { stdout, stderr, clientFactory }), stdout: stdout.text, stderr: stderr.text }; };
  assert.deepEqual([(await run(['access'])).stdout, calls.at(-1)], ['guarded\n', ['access.read', {}]]);
  const full = await run(['access', 'full']);
  assert.equal(full.code, 0); assert.equal(full.stdout, 'full\n'); assert.match(full.stderr, /devmate access guarded/);
  assert.deepEqual(calls.at(-1), ['access.update', { profile: 'full' }]);
  assert.equal((await run(['access', 'guarded'])).stdout, 'guarded\n');
  const wrong = await run(['access', 'everything']);
  assert.equal(wrong.code, 1); assert.match(wrong.stderr, /access guarded or access full/);
});
