import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult } from '../runtime/mcp.mjs';

const owner = Object.freeze({ id: 'owner', surface: 'local' });
const connected = Object.freeze({ id: 'owner' });
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
// within: the project is that folder inside the repository, not the repository's top folder.
async function fixture(t, { repository = true, instance = 'instance', within = '' } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-isolation-'));
  const top = path.join(temp, 'project'), root = path.join(top, within); fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  fs.writeFileSync(path.join(root, 'old.txt'), 'to be deleted\n');
  if (within) { fs.mkdirSync(path.join(top, 'other')); fs.writeFileSync(path.join(top, 'other', 'b.txt'), 'beside the project\n'); }
  if (repository) { git(top, 'init', '--quiet', '-b', 'main'); git(top, 'add', '.'); git(top, 'commit', '--quiet', '-m', 'first'); }
  const { factory, instances } = adapters();
  const service = new DevMateService({ instanceRoot: path.join(temp, instance), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: factory });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const project = await service.call('project.create', { root, name: 'Isolation' }, owner);
  const file = name => path.join(root, name), read = name => fs.readFileSync(file(name), 'utf8').replace(/\r\n/g, '\n');
  return { service, project, root, top, temp, factory, instances, file, read };
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

// Where DevMate is installed without being told otherwise, its instance is ~/.devmate/runtime, and the copies are
// beside it, in a folder named .devmate: a name no shared folder may have above it.
test('a copy beside an instance that lives in a folder named .devmate is read, applied and discarded like any other', async t => {
  const { service, project, root, temp, factory, instances, read } = await fixture(t, { instance: path.join('.devmate', 'runtime') });
  factory.work = work;
  const delegate = () => service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Change b', isolate: true, waitMs: 20000 }, connected);
  const done = await delegate();
  const copies = path.join(temp, '.devmate', 'runtime-copies'), copy = instances[0].options.cwd;
  assert.ok(copy.startsWith(copies + path.sep), 'the copy is beside the instance: ' + copy);
  assert.deepEqual(done.proposedFiles.sort(), ['A src/new.js', 'D old.txt', 'M src/a.js']);
  const proposal = await service.call('agents.proposal', { agentId: done.agentId }, connected);
  assert.deepEqual(proposal.files.map(item => item.status + ' ' + item.path).sort(), ['A src/new.js', 'D old.txt', 'M src/a.js']); assert.match(proposal.stdout, /-const b = 2;\n\+const b = 20;/);
  const applied = await service.call('agents.apply', { agentId: done.agentId }, connected);
  assert.equal(applied.applied, true); assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n'); assert.equal(fs.existsSync(copy), false);
  git(root, 'add', '.'); git(root, 'commit', '--quiet', '-m', 'second');
  factory.work = cwd => fs.writeFileSync(path.join(cwd, 'src', 'second.js'), 'export {};\n');
  const other = await delegate();
  assert.equal((await service.call('agents.proposal', { agentId: other.agentId }, connected)).files.length, 1);
  await service.call('agents.discard', { agentId: other.agentId }, connected);
  assert.equal(fs.existsSync(instances[1].options.cwd), false); assert.equal(git(root, 'branch', '--list', 'devmate/*').trim(), '');
  // What is let through is a copy this runtime made, where it makes them. A folder the owner shares is held to the
  // rule as before, there too; and a folder that is not such a copy is not read as one.
  fs.mkdirSync(path.join(copies, 'shared'), { recursive: true });
  await assert.rejects(service.call('project.create', { root: path.join(copies, 'shared') }, owner), { code: 'protected_workspace_root' });
  const elsewhere = path.join(temp, 'elsewhere'); fs.mkdirSync(elsewhere);
  for (const place of [elsewhere, copies, path.join(temp, '.devmate', 'runtime')]) {
    await assert.rejects(service.workspace.proposal(service.project(project.id), { root: place, branch: 'devmate/x', base: git(root, 'rev-parse', 'HEAD').trim() }), { code: 'invalid_input' }, place);
  }
});

// A copy is a Git worktree, and that is the whole repository. For a project that is one folder of a repository the
// rest of what applying does would go wrong: Git applies a patch from inside a folder to that folder only and says
// nothing of the rest, so work outside it would be lost with the copy while the answer listed it as applied; and
// what was applied would be looked for one folder too deep, and never reach the history.
test('a project that is a folder inside a larger repository gets no copy: it is refused before anything is made', async t => {
  const { service, project, root, top, temp, factory, instances, read } = await fixture(t, { within: 'pkg' });
  factory.work = cwd => { work(cwd); fs.writeFileSync(path.join(cwd, '..', 'other', 'b.txt'), 'changed beside the project\n'); };
  await assert.rejects(service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Change b', isolate: true, waitMs: 20000 }, connected), error => {
    assert.equal(error.code, 'not_repository_root');
    assert.match(error.message, /^A copy of its own needs the project to be the top folder of its Git repository: this project is the folder pkg inside one\. Delegate without isolate, or share the repository's top folder as the project\.$/);
    return true;
  });
  // Nothing was made, and nobody was started.
  assert.equal(instances.length, 0); assert.equal(fs.existsSync(path.join(temp, 'instance-copies')), false);
  assert.equal(git(top, 'branch', '--list', 'devmate/*').trim(), ''); assert.equal(git(top, 'worktree', 'list').trim().split('\n').length, 1);
  // Without a copy the agent works in the project's folder as before.
  const direct = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Change b', waitMs: 20000 }, connected);
  assert.equal(direct.settled, true); assert.equal(instances[0].options.cwd, fs.realpathSync.native(root)); assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
});

// An owner who has switched on Git's own file watcher (core.fsmonitor in their Git configuration) gets one for every
// folder Git is used in. The agent's Git starts it in the copy, and it stays when the agent has gone, with the
// folder open: on Windows a folder that is open cannot be removed. Seen with the real Codex on the owner's computer.
test('a copy that Git itself still watches is applied and removed all the same', { timeout: 120000 }, async t => {
  const { service, project, root, factory, instances, read } = await fixture(t);
  const said = (cwd, ...args) => { const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return String(result.stdout) + String(result.stderr); };
  let watched = false;
  factory.work = cwd => { work(cwd); said(cwd, '-c', 'core.fsmonitor=true', 'status', '--porcelain'); watched = /is watching/.test(said(cwd, 'fsmonitor--daemon', 'status')); };
  const done = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Change b', isolate: true, waitMs: 20000 }, connected);
  const copy = instances[0].options.cwd;
  try {
    if (!watched) t.diagnostic('this Git has no file watcher of its own here: nothing holds the copy');
    const applied = await service.call('agents.apply', { agentId: done.agentId }, connected);
    assert.equal(applied.applied, true); assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
    assert.equal(fs.existsSync(copy), false, 'the folder of the copy is gone'); assert.equal(git(root, 'branch', '--list', 'devmate/*').trim(), '');
    assert.equal(service.store.get('agent', done.agentId).isolated.settled, 'applied');
  } finally { if (fs.existsSync(copy)) said(copy, 'fsmonitor--daemon', 'stop'); }
});

// Whatever else still stands in the copy when its work is applied: the work is in the project all the same, and the
// answer is not that it failed.
test('work is applied also where its copy cannot be removed yet, and what is left is said', { skip: process.platform !== 'win32' && 'a folder a program stands in can be removed here', timeout: 120000 }, async t => {
  const { service, project, root, factory, instances, read } = await fixture(t);
  factory.work = work;
  const done = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'Change b', isolate: true, waitMs: 20000 }, connected);
  const copy = instances[0].options.cwd;
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: copy, stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => { holder.once('spawn', resolve); holder.once('error', reject); });
  try {
    const applied = await service.call('agents.apply', { agentId: done.agentId }, connected);
    assert.equal(applied.applied, true); assert.deepEqual(applied.files.sort(), ['old.txt', 'src/a.js', 'src/new.js']); assert.equal(applied.copyLeft, true);
    assert.match(applied.note, /could not be removed, because a program still uses its folder: .*copy-[a-f0-9]{12}\. When nothing uses it any more, delete that folder and run "git worktree prune" and "git branch -D devmate\/copy-[a-f0-9]{12}" in the project\.$/);
    assert.equal(read('src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n'); assert.equal(fs.existsSync(path.join(root, 'old.txt')), false);
    // It is applied, and is not applied a second time.
    assert.equal(service.store.get('agent', done.agentId).isolated.settled, 'applied');
    await assert.rejects(service.call('agents.apply', { agentId: done.agentId }, connected), { code: 'agent_finished' });
  } finally { holder.kill(); await new Promise(resolve => holder.once('exit', resolve)); }
});

test('a very large file an agent brought is taken back only while it is as the agent left it', { timeout: 120000 }, async t => {
  const { service, project, factory, file } = await fixture(t);
  // Larger than a file these tools read whole (8 MiB): its content is still known after the work is applied.
  const large = Buffer.alloc(9 * 1024 * 1024, 0x61);
  factory.work = (cwd, text) => fs.writeFileSync(path.join(cwd, text + '.bin'), large);
  const arrive = async name => {
    const point = (await service.call('workspace.history', { projectId: project.id }, connected)).items[0]?.sequence ?? 0;
    const done = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: name, isolate: true, waitMs: 50000 }, connected);
    assert.equal((await service.call('agents.apply', { agentId: done.agentId }, connected)).applied, true);
    const entry = (await service.call('workspace.history', { projectId: project.id }, connected)).items.find(item => item.path === name + '.bin');
    assert.match(String(entry.sha256), /^[a-f0-9]{64}$/, 'what the work wrote is recorded although it is too large to read whole');
    return point;
  };
  // The person went on working in it: taking the agent's work back leaves it alone, and says so.
  const first = await arrive('kept');
  fs.appendFileSync(file('kept.bin'), 'mine');
  const left = await service.call('workspace.restore', { projectId: project.id, since: first }, connected);
  assert.deepEqual([left.restored, left.left.map(item => [item.path, item.reason])], [[], [['kept.bin', 'it was changed again by something else']]]);
  assert.equal(fs.statSync(file('kept.bin')).size, large.length + 4, 'the person\'s file is as they left it');
  // Nobody touched it: it goes again with the rest.
  const second = await arrive('gone');
  const taken = await service.call('workspace.restore', { projectId: project.id, since: second }, connected);
  assert.deepEqual(taken.restored.map(item => [item.path, item.action]), [['gone.bin', 'removed again (this change created it)']]);
  assert.equal(fs.existsSync(file('gone.bin')), false); assert.equal(fs.existsSync(file('kept.bin')), true);
});

test('a link an agent\'s work brought is applied and said not to be in the history', { skip: process.platform === 'win32' && 'links are plain files to Git on Windows', timeout: 60000 }, async t => {
  const { service, project, factory, file } = await fixture(t);
  factory.work = cwd => { fs.symlinkSync('src/a.js', path.join(cwd, 'shortcut')); fs.writeFileSync(path.join(cwd, 'plain.txt'), 'a file\n'); };
  const point = (await service.call('workspace.history', { projectId: project.id }, connected)).items[0]?.sequence ?? 0;
  const done = await service.call('agents.delegate', { projectId: project.id, provider: 'codex', prompt: 'link', isolate: true, waitMs: 20000 }, connected);
  const applied = await service.call('agents.apply', { agentId: done.agentId }, connected);
  assert.deepEqual([applied.applied, applied.files.sort(), applied.notInHistory], [true, ['plain.txt', 'shortcut'], ['shortcut']]);
  assert.match(applied.note, /not in the history \(links and other entries that are no plain files\): workspace_restore does not take these back\. Use Git for them: shortcut$/);
  assert.equal(fs.lstatSync(file('shortcut')).isSymbolicLink(), true);
  // Taking the work back takes the file and leaves the link, as it was told.
  const taken = await service.call('workspace.restore', { projectId: project.id, since: point }, connected);
  assert.deepEqual(taken.restored.map(item => item.path), ['plain.txt']); assert.equal(fs.lstatSync(file('shortcut')).isSymbolicLink(), true);
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
  // Taking the project out of DevMate takes the copies with it: their folders and their branches.
  const copies = path.join(temp, 'instance-copies');
  assert.equal(fs.readdirSync(copies).length, 1);
  for (const agent of [direct.agentId, running.agentId]) await service.call('agents.stop', { id: agent }, owner);
  await service.call('project.remove', { id: project.id }, owner);
  assert.deepEqual(fs.readdirSync(copies), []); assert.equal(git(root, 'branch', '--list', 'devmate/*').trim(), '');
});
