import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult } from '../runtime/mcp.mjs';

const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const connected = Object.freeze({ id: 'owner', role: 'owner' });
const git = (cwd, ...args) => {
  const result = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr);
  return result.stdout;
};
// A native adapter stand-in whose "agent" does its work on disk, in the directory it was started in.
function adapters() {
  const instances = [];
  const factory = options => {
    const instance = { options, prompts: [], closed: false, capabilities: { steer: false, approvals: true, mcp: true },
      async start() { return { sessionId: 'native-' + instances.indexOf(instance), model: 'fixture', capabilities: instance.capabilities }; },
      async send({ text }) {
        instance.prompts.push(text);
        if (factory.slow) await new Promise(resolve => { instance.finish = resolve; });
        factory.work?.(options.cwd, text);
        return { status: 'completed', text: 'done: ' + text, native: {} };
      },
      async cancel() { instance.finish?.(); return { requested: true }; },
      async close() { instance.closed = true; instance.finish?.(); }
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}
async function fixture(t, { repository = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-isolation-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  fs.writeFileSync(path.join(root, 'old.txt'), 'to be deleted\n');
  if (repository) { git(root, 'init', '--quiet', '-b', 'main'); git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'first'); }
  const { factory, instances } = adapters();
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: factory });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = await service.call('project.create', { root, name: 'Isolation' }, owner);
  const file = name => path.join(root, name), read = name => fs.readFileSync(file(name), 'utf8').replace(/\r\n/g, '\n');
  return { service, project, root, temp, factory, instances, file, read };
}
// What the stand-in agent does: an edit, a new file and a deletion.
const work = cwd => {
  const a = path.join(cwd, 'src', 'a.js');
  fs.writeFileSync(a, fs.readFileSync(a, 'utf8').replace('const b = 2;', 'const b = 20;'));
  fs.writeFileSync(path.join(cwd, 'src', 'new.js'), 'export const added = true;\n');
  fs.rmSync(path.join(cwd, 'old.txt'));
};

test('an agent with a copy of its own leaves the project alone until its work is read and applied', async t => {
  const { service, project, root, temp, factory, instances, file, read } = await fixture(t);
  // Something the person has not committed: it is not in the copy, and it is not touched.
  fs.writeFileSync(file('scratch.txt'), 'mine\n');
  factory.work = work;
  const done = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Change b', isolate: true, waitMs: 20000 }, connected);
  assert.equal(done.settled, true); assert.equal(done.output, 'done: Change b');
  const copy = instances[0].options.cwd;
  // The copy is beside the instance directory, never inside it: the owner token and the stored credentials are not above the agent's folder.
  assert.notEqual(copy, root); assert.ok(copy.startsWith(path.join(temp, 'instance-copies') + path.sep), 'the agent was started in a copy of its own: ' + copy);
  assert.ok(!copy.startsWith(path.join(temp, 'instance') + path.sep));
  // The project is exactly as it was.
  assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n'); assert.equal(fs.existsSync(file('src/new.js')), false); assert.equal(fs.existsSync(file('old.txt')), true);
  assert.equal(git(root, 'status', '--porcelain').trim(), '?? scratch.txt');
  // The answer says what is proposed and how to go on.
  assert.deepEqual(done.proposedFiles.sort(), ['A src/new.js', 'D old.txt', 'M src/a.js']);
  assert.match(done.copyNote, /1 uncommitted change\(s\) of the project are not in it, and neither are ignored files such as installed dependencies/); assert.match(done.copyNote, /install what it needs first/);
  const shown = presentResult(service.operations.get('agents.delegate'), done).content[0].text;
  assert.match(shown, /The agent worked in a copy of its own: the project is unchanged\. It proposes:\n {2}/); assert.match(shown, /operations_query \{operation:"agents\.proposal", input:\{agentId:"agent-/); assert.match(shown, /agents\.apply/);
  // Reading the proposal: the files and the diff against the commit the agent started from. The copy's own index is
  // the agent's and is not touched by reading: Git in the copy still sees the new file as untracked.
  const point = (await service.call('workspace.history', { projectId: project.id }, connected)).items[0]?.sequence ?? 0;
  const proposal = await service.call('agents.proposal', { agentId: done.agentId }, connected);
  assert.match(git(copy, 'status', '--porcelain'), /^\?\? src\/new\.js$/m);
  assert.deepEqual(fs.readdirSync(path.dirname(copy)).filter(name => name.includes('.index-')), [], 'the index it was worked out in is gone');
  assert.deepEqual(proposal.files.map(item => item.status + ' ' + item.path).sort(), ['A src/new.js', 'D old.txt', 'M src/a.js']);
  assert.match(proposal.stdout, /-const b = 2;\n\+const b = 20;/); assert.match(proposal.stdout, /\+export const added = true;/); assert.match(proposal.branch, /^devmate\/copy-[a-f0-9]{12}$/);
  assert.match((await service.call('agents.proposal', { agentId: done.agentId, paths: ['src/new.js'] }, connected)).stdout, /^diff --git a\/src\/new\.js/);
  assert.match(presentResult(service.operations.get('agents.proposal'), proposal).content[0].text, /^D old\.txt\nM src\/a\.js\nA src\/new\.js\n\ndiff --git/);
  // Applying brings all of it into the working tree, as changes the person commits themselves.
  const head = git(root, 'rev-parse', 'HEAD').trim();
  const applied = await service.call('agents.apply', { agentId: done.agentId }, connected);
  assert.equal(applied.applied, true); assert.deepEqual(applied.files.sort(), ['old.txt', 'src/a.js', 'src/new.js']);
  assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n'); assert.equal(read('src/new.js'), 'export const added = true;\n'); assert.equal(fs.existsSync(file('old.txt')), false);
  assert.equal(read('scratch.txt'), 'mine\n'); assert.equal(git(root, 'rev-parse', 'HEAD').trim(), head, 'nothing was committed');
  // What arrived is in the history like any other change, so one call takes the agent's work back again.
  const history = (await service.call('workspace.history', { projectId: project.id }, connected)).items.filter(item => item.sequence > point);
  assert.deepEqual(history.map(item => item.action + ' ' + item.path).sort(), ['removed old.txt', 'written src/a.js', 'written src/new.js']);
  const taken = await service.call('workspace.restore', { projectId: project.id, since: point }, connected);
  assert.deepEqual(taken.left, []);
  assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n'); assert.equal(fs.existsSync(file('src/new.js')), false); assert.equal(read('old.txt'), 'to be deleted\n');
  // And back once more: taking back is itself in the history.
  await service.call('workspace.restore', { projectId: project.id, since: history.at(0).sequence }, connected);
  assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n'); assert.equal(read('src/new.js'), 'export const added = true;\n'); assert.equal(fs.existsSync(file('old.txt')), false);
  // The copy has done its job: its folder, its branch and its process are gone, and the agent is finished.
  assert.equal(fs.existsSync(copy), false); assert.equal(git(root, 'branch', '--list', 'devmate/*').trim(), ''); assert.equal(git(root, 'worktree', 'list').trim().split('\n').length, 1);
  assert.equal(instances[0].closed, true); assert.equal(service.store.get('agent', done.agentId).isolated.settled, 'applied');
  await assert.rejects(service.call('agents.delegate', { projectId: project.id, agentId: done.agentId, prompt: 'more' }, connected), { code: 'agent_finished' });
  await assert.rejects(service.call('agents.apply', { agentId: done.agentId }, connected), { code: 'agent_finished' });
  assert.equal(instances.length, 1);
});

test('work that no longer fits is not applied in part, stays on its branch, and can be discarded', async t => {
  const { service, project, root, factory, instances, file, read } = await fixture(t);
  factory.work = work;
  const done = await service.call('agents.delegate', { projectId: project.id, provider: 'claude', prompt: 'Change b', isolate: true, waitMs: 20000 }, connected);
  const copy = instances[0].options.cwd, branch = service.store.get('agent', done.agentId).isolated.branch;
  // Meanwhile the person changed the same line.
  fs.writeFileSync(file('src/a.js'), 'const a = 1;\nconst b = 200;\nconst c = 3;\n');
  await assert.rejects(service.call('agents.apply', { agentId: done.agentId }, connected), error => {
    assert.equal(error.code, 'conflict'); assert.match(error.message, /Nothing was applied/); assert.ok(error.message.includes(branch)); return true;
  });
  // Nothing of it arrived: not the edit, and not the new file or the deletion that would have applied on their own.
  assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 200;\nconst c = 3;\n'); assert.equal(fs.existsSync(file('src/new.js')), false); assert.equal(fs.existsSync(file('old.txt')), true);
  // The work is kept as a commit on the copy's branch, for merging by hand.
  assert.match(git(root, 'log', '-1', '--format=%s', branch), /Work of a delegated agent/); assert.match(git(root, 'show', branch + ':src/a.js'), /const b = 20;/);
  assert.equal(fs.existsSync(copy), true); assert.equal(service.store.get('agent', done.agentId).isolated.settled, undefined);
  const discarded = await service.call('agents.discard', { agentId: done.agentId }, connected);
  assert.equal(discarded.discarded, true); assert.equal(fs.existsSync(copy), false); assert.equal(git(root, 'branch', '--list', 'devmate/*').trim(), '');
  assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 200;\nconst c = 3;\n', 'the project is not touched by discarding');
  await assert.rejects(service.call('agents.proposal', { agentId: done.agentId }, connected), { code: 'agent_finished' });
});

test('a copy needs a repository, belongs to a new agent, and is not taken away while the agent works', async t => {
  const plain = await fixture(t, { repository: false });
  await assert.rejects(plain.service.call('agents.delegate', { projectId: plain.project.id, provider: 'codex', prompt: 'x', isolate: true }, connected), { code: 'not_a_repository' });
  assert.equal(plain.instances.length, 0, 'no agent was started');

  const { service, project, root, temp, factory, instances } = await fixture(t);
  // An agent that works in the project itself has nothing to review.
  const direct = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'in place', waitMs: 20000 }, connected);
  assert.equal(instances[0].options.cwd, project.root); assert.equal(direct.proposedFiles, undefined);
  for (const operation of ['agents.proposal', 'agents.apply', 'agents.discard']) await assert.rejects(service.call(operation, { agentId: direct.agentId }, connected), { code: 'not_isolated' }, operation);
  await assert.rejects(service.call('agents.delegate', { projectId: project.id, agentId: direct.agentId, prompt: 'again', isolate: true }, connected), { code: 'invalid_input', message: /chosen when an agent is started/ });
  // While its task runs, its copy stays.
  factory.slow = true;
  const running = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'long', isolate: true, waitMs: 200 }, connected);
  assert.equal(running.settled, false);
  for (const operation of ['agents.apply', 'agents.discard']) await assert.rejects(service.call(operation, { agentId: running.agentId }, connected), { code: 'agent_busy' }, operation);
  instances[1].finish();
  assert.equal((await service.call('agents.result', { agentId: running.agentId, waitMs: 20000 }, connected)).settled, true);
  // A reader may read what is proposed and may not bring it into the project.
  const reader = { id: 'member', role: 'read', projectIds: [project.id] };
  assert.deepEqual((await service.call('agents.proposal', { agentId: running.agentId }, reader)).files, []);
  await assert.rejects(service.call('agents.apply', { agentId: running.agentId }, reader), { code: 'forbidden' });
  // Taking the project out of DevMate takes the copies with it: their folders and their branches.
  const copies = path.join(temp, 'instance-copies');
  assert.equal(fs.readdirSync(copies).length, 1);
  for (const agent of [direct.agentId, running.agentId]) await service.call('agents.stop', { id: agent }, owner);
  await service.call('project.remove', { id: project.id }, owner);
  assert.deepEqual(fs.readdirSync(copies), []); assert.equal(git(root, 'branch', '--list', 'devmate/*').trim(), '');
});
