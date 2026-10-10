import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult, serverInstructions, MODEL_VISIBLE_OPERATIONS } from '../runtime/mcp.mjs';

const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// A native adapter stand-in: each instance is one owned agent process.
function adapters() {
  const instances = [];
  const factory = options => {
    const instance = { options, prompts: [], mode: 'complete', capabilities: { steer: false, approvals: true, mcp: true },
      async start() { if (instance.mode === 'missing') throw Object.assign(new Error('codex is not installed'), { code: 'agent_not_installed' });
        return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
      async send({ text }) {
        instance.prompts.push(text);
        if (instance.mode === 'slow') await new Promise(resolve => instance.finish = resolve);
        if (instance.mode === 'approval') {
          instance.controller = new AbortController();
          try { await options.onApproval({ id: 'native-approval', kind: 'Write', options: [{ optionId: 'allow', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }], details: {}, native: {} }, { signal: instance.controller.signal }); }
          catch { return { status: 'interrupted' }; }
        }
        return { status: 'completed', text: 'done: ' + text, native: {} };
      },
      async cancel() { instance.controller?.abort(); instance.finish?.(); return { requested: true }; },
      async close() { instance.controller?.abort(); instance.finish?.(); }
    };
    instance.mode = factory.nextMode || 'complete';
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-delegate-'));
  const root = path.join(temp, 'project'), other = path.join(temp, 'other'); fs.mkdirSync(root); fs.mkdirSync(other);
  const { factory, instances } = adapters();
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: factory });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const project = await service.call('project.create', { root, name: 'Delegation' }, owner);
  const second = await service.call('project.create', { root: other, name: 'Other' }, owner);
  return { service, project, second, factory, instances };
}

test('one call starts an agent, runs the task and returns its result; a second call continues the same session', async t => {
  const { service, project, instances } = await fixture(t);
  const first = await service.call('agents.delegate', { projectId: 'Delegation', provider: 'claude', prompt: 'Fix the failing test\nDetails follow', waitMs: 5000 }, owner);
  assert.equal(first.settled, true); assert.equal(first.status, 'ready'); assert.equal(first.output, 'done: Fix the failing test\nDetails follow');
  assert.equal(first.turn.status, 'completed'); assert.equal(first.provider, 'claude');
  assert.equal(service.store.get('workflow', first.workflowId).title, 'Delegated: Fix the failing test');
  assert.equal(instances.length, 1); assert.equal(instances[0].options.cwd, project.root);
  const again = await service.call('agents.delegate', { projectId: project.id, agentId: first.agentId, prompt: 'Now add a regression test', waitMs: 5000 }, owner);
  assert.equal(again.agentId, first.agentId); assert.equal(again.workflowId, first.workflowId);
  assert.equal(again.output, 'done: Now add a regression test'); assert.notEqual(again.turn.jobId, first.turn.jobId);
  assert.equal(instances.length, 1, 'the same native session is reused');
  assert.deepEqual(instances[0].prompts, ['Fix the failing test\nDetails follow', 'Now add a regression test']);
  const shown = presentResult(service.operations.get('agents.delegate'), again);
  // The answer is text for the delegating model; the ids to continue with follow on the last line.
  assert.match(shown.content[0].text, /^done: Now add a regression test\n\[agent ready\]\n\{/);
  assert.equal(shown.structuredContent, undefined);
  const follow = JSON.parse(shown.content[0].text.split('\n').at(-1));
  assert.deepEqual([follow.agentId, follow.jobId, follow.settled], [again.agentId, again.turn.jobId, true]);
});

test('a task that outlasts waitMs returns an agent to follow, and agents_result waits for the outcome', async t => {
  const { service, project, factory, instances } = await fixture(t);
  factory.nextMode = 'slow';
  const pending = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Long refactor', waitMs: 150 }, owner);
  assert.equal(pending.settled, false); assert.equal(pending.status, 'running'); assert.equal(pending.output, '');
  assert.match(presentResult(service.operations.get('agents.delegate'), pending).content[0].text, /call agents_result agentId:agent-/);
  const waiting = service.call('agents.result', { id: pending.agentId, waitMs: 5000 }, owner);
  await delay(100); instances[0].finish();
  const finished = await waiting;
  assert.equal(finished.settled, true); assert.equal(finished.output, 'done: Long refactor');
  assert.equal((await service.call('agents.result', { id: pending.agentId }, owner)).turn.status, 'completed');
});

test('approvals and unavailable agents surface immediately instead of being waited out', async t => {
  const { service, project, second, factory } = await fixture(t);
  factory.nextMode = 'approval';
  const started = Date.now();
  const blocked = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Write a file', waitMs: 20000 }, owner);
  assert.ok(Date.now() - started < 5000, 'an approval request ends the wait');
  assert.equal(blocked.status, 'waiting'); assert.equal(blocked.settled, false);
  assert.deepEqual(blocked.approvals.map(item => item.options), [['Allow once', 'Deny']]);
  await service.call('approval.resolve', { id: blocked.approvals[0].id, optionId: 'allow' }, owner);
  const resolved = await service.call('agents.result', { id: blocked.agentId, waitMs: 5000 }, owner);
  assert.equal(resolved.settled, true); assert.equal(resolved.output, 'done: Write a file');
  factory.nextMode = 'missing';
  const missing = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'x', waitMs: 5000 }, owner);
  assert.equal(missing.status, 'unavailable'); assert.equal(missing.settled, true); assert.equal(missing.error.code, 'agent_not_installed'); assert.equal(missing.turn, null);
  await assert.rejects(service.call('agents.delegate', { projectId: project.id, prompt: 'no provider' }, owner), { code: 'invalid_input' });
  await assert.rejects(service.call('agents.delegate', { projectId: second.id, agentId: blocked.agentId, prompt: 'cross project' }, owner), { code: 'scope_mismatch' });
  const reader = { id: 'reader', role: 'read', projectIds: [project.id] };
  await assert.rejects(service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'x' }, reader), { code: 'forbidden' });
  assert.equal((await service.call('agents.result', { id: blocked.agentId }, reader)).status, 'ready', 'a reader may observe results');
  await assert.rejects(service.call('agents.result', { id: blocked.agentId }, { id: 'outsider', role: 'write', projectIds: [second.id] }), { code: 'forbidden' });
});

test('the model is told how to work: registered projects, the shell in use and the delegation path', async t => {
  const { service, project } = await fixture(t);
  const text = serverInstructions(service, owner);
  assert.match(text, new RegExp(project.id + ' = Delegation'));
  assert.ok(text.includes(service.processes.shell.label)); assert.match(text, /agents_delegate/); assert.match(text, /workspace_edit/);
  assert.equal(serverInstructions(service, { id: 'm', role: 'read', projectIds: [] }).includes(project.id), false, 'a member is not shown projects outside its grants');
  for (const name of ['shell.run', 'process.read', 'workspace.edit', 'workspace.find', 'workspace.restore', 'git.log', 'agents.delegate', 'agents.result']) {
    assert.ok(MODEL_VISIBLE_OPERATIONS.has(name), name + ' is visible to the model'); assert.ok(service.operations.has(name), name + ' exists');
  }
  for (const name of MODEL_VISIBLE_OPERATIONS) assert.ok(service.operations.has(name), 'visible operation is registered: ' + name);
  assert.equal(MODEL_VISIBLE_OPERATIONS.has('project.create'), false, 'sharing a folder is not a tool: the owner does it at their computer');
  assert.ok(MODEL_VISIBLE_OPERATIONS.size <= 40, 'the tool list a model always carries stays small');
});

test('less common operations are one generic call away and keep their own authorization', async t => {
  const { service, project, second } = await fixture(t);
  const remote = { id: 'owner', role: 'owner' };
  const summary = await service.call('operations.list', { summary: true }, remote);
  assert.ok(summary.items.some(item => item.name === 'task.create')); assert.equal(summary.items[0].inputSchema, undefined);
  assert.equal(summary.items.some(item => item.name === 'secret.set' || item.name === 'runtime.doctor'), false, 'local-only operations are not offered to an MCP caller');
  const one = await service.call('operations.list', { name: 'workflow.create' }, remote);
  assert.equal(one.items.length, 1); assert.ok(one.items[0].inputSchema.properties.turnBudget);
  const workflow = await service.call('operations.call', { operation: 'workflow.create', input: { projectId: project.id, title: 'Through the generic call' } }, remote);
  assert.equal(service.store.get('workflow', workflow.id).title, 'Through the generic call');
  for (const operation of ['secret.list', 'settings.read', 'runtime.stop', 'operations.call', 'no.such']) {
    await assert.rejects(service.call('operations.call', { operation }, remote), { code: 'unknown_operation' }, operation);
  }
  const reader = { id: 'reader', role: 'read', projectIds: [project.id] };
  assert.ok((await service.call('operations.call', { operation: 'workflow.list', input: { projectId: project.id } }, reader)).items.length);
  await assert.rejects(service.call('operations.call', { operation: 'workflow.create', input: { projectId: project.id, title: 'x' } }, reader), { code: 'forbidden' });
  await assert.rejects(service.call('operations.call', { operation: 'workflow.list', input: { projectId: second.id } }, reader), { code: 'forbidden' });
  await assert.rejects(service.call('operations.call', { operation: 'project.remove', input: { id: project.id } }, { id: 'writer', role: 'write', projectIds: [project.id] }), { code: 'forbidden' });
});

test('a finished delegation says what the working tree looks like afterwards', async t => {
  const { service, project } = await fixture(t);
  const { spawnSync } = await import('node:child_process');
  assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: project.root, windowsHide: true }).status, 0);
  fs.writeFileSync(path.join(project.root, 'created-by-agent.txt'), 'work'); fs.writeFileSync(path.join(project.root, '.env'), 'SECRET=1');
  const result = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Create the file', waitMs: 5000 }, owner);
  assert.equal(result.settled, true);
  assert.deepEqual(result.changedFiles.sort(), ['?? .env', '?? created-by-agent.txt']);
  const shown = presentResult(service.operations.get('agents.delegate'), result).content[0].text;
  assert.match(shown, /Working tree after this task \(git status\):\n {2}\?\? /); assert.equal(shown.includes('SECRET'), false);
  assert.deepEqual((await service.call('agents.result', { id: result.agentId, jobId: result.jobId }, owner)).changedFiles.sort(), result.changedFiles.sort());
});
