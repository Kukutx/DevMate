import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProcessManager } from '../runtime/processes.mjs';
import { DevMateService } from '../runtime/service.mjs';
import { presentResult } from '../runtime/mcp.mjs';

const node = process.execPath;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-process-'));
  const root = path.join(temp, 'project'); fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  const events = [];
  const manager = createProcessManager({ instanceRoot: path.join(temp, 'instance'), store: { event: (...value) => events.push(value) } });
  t.after(async () => { await manager.close().catch(() => {}); fs.rmSync(temp, { recursive: true, force: true }); });
  return { temp, root, manager, events, project: { id: 'project-test', root, access: 'write' } };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('shell command text runs package-manager shims, inherits the owner environment and reports the real exit code', async t => {
  const { manager, project, root } = fixture(t);
  const key = 'DEVMATE_PROCESS_TEST', previous = process.env[key];
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const inherited = createProcessManager({ instanceRoot: path.join(root, '..', 'second'), env: { ...process.env, [key]: '继承 ✓' } });
  t.after(() => inherited.close());
  const printed = await inherited.run(project, { command: "node -e 'console.log(process.env.DEVMATE_PROCESS_TEST + `|` + process.cwd())'", cwd: 'sub' });
  assert.equal(printed.status, 'exited'); assert.equal(printed.exitCode, 0);
  assert.equal(printed.output.trim(), '继承 ✓|' + path.join(root, 'sub'));
  const failed = await manager.run(project, { command: "node -e 'process.exit(7)'" });
  assert.equal(failed.exitCode, 7); assert.equal(failed.status, 'exited');
  const npm = await manager.run(project, { command: 'npm --version' });
  assert.equal(npm.exitCode, 0, npm.output); assert.match(npm.output.trim(), /^\d+\.\d+\.\d+/);
  assert.ok(fs.readdirSync(path.join(root, '..', 'instance', 'processes')).every(name => name.endsWith('.log')), 'private launch scripts are removed after exit');
});

test('exact executable launch keeps arguments literal and rejects shims, bad cwd and read-only projects', async t => {
  const { manager, project } = fixture(t);
  const literal = await manager.run(project, { file: node, args: ['-e', 'console.log(process.argv[1])', '& $(literal) "quoted"'] });
  assert.equal(literal.output.trim(), '& $(literal) "quoted"'); assert.equal(literal.shell, 'direct');
  await assert.rejects(manager.run(project, { file: 'npm.cmd', args: [] }), { code: 'invalid_command' });
  await assert.rejects(manager.run(project, { file: node, args: [], cwd: '../' }), { code: 'outside_project' });
  await assert.rejects(manager.run(project, { file: node, command: 'x' }), { code: 'invalid_command' });
  await assert.rejects(manager.run({ ...project, access: 'read' }, { file: node, args: ['-v'] }), { code: 'read_only' });
});

test('a long-running command returns while running, streams by cursor and stops with its whole tree', async t => {
  const { manager, project, root } = fixture(t);
  const marker = path.join(root, 'child.pid');
  const source = "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
    "c.once('spawn',()=>require('node:fs').writeFileSync(process.argv[1],String(c.pid)));let n=0;setInterval(()=>console.log('tick '+(++n)),50);";
  const started = await manager.run(project, { file: node, args: ['-e', source, marker], waitMs: 400 });
  assert.equal(started.status, 'running');
  // On a busy machine the program may not have printed yet when the first wait ends; the cursor read then carries its first line.
  const more = await manager.read({ id: started.id, cursor: started.cursor, waitMs: 5000 });
  assert.equal(more.status, 'running'); assert.match(more.output, /tick \d+/); assert.ok(more.cursor > started.cursor);
  assert.match(started.output + more.output, /^tick 1\r?\n/, 'nothing is lost between the first answer and the read that follows');
  assert.equal(manager.list(project.id).items[0].status, 'running');
  const childPid = Number(fs.readFileSync(marker, 'utf8'));
  const stopped = await manager.stop({ id: started.id });
  assert.equal(stopped.status, 'stopped');
  await delay(100);
  assert.equal(alive(started.pid), false); assert.equal(alive(childPid), false, 'descendants are terminated with the command');
  assert.equal((await manager.stop({ id: started.id })).status, 'stopped', 'stopping twice is harmless');
});

test('interactive commands accept standard input and long-poll reads wake on exit', async t => {
  const { manager, project } = fixture(t);
  const started = await manager.run(project, { file: node, interactive: true, waitMs: 0,
    args: ['-e', "process.stdin.once('data',d=>{console.log('got:'+String(d).trim());process.exit(3)})"] });
  assert.equal(started.status, 'running');
  await assert.rejects(async () => manager.write({ id: (await manager.run(project, { file: node, args: ['-e', 'setTimeout(()=>{},300)'], waitMs: 0 })).id, input: 'x' }), { code: 'stdin_closed' });
  manager.write({ id: started.id, input: 'hello\n' });
  let state = await manager.read({ id: started.id, cursor: 0, waitMs: 5000 });
  while (state.status === 'running') state = await manager.read({ id: started.id, cursor: state.cursor, waitMs: 5000 });
  const final = await manager.read({ id: started.id, cursor: 0 });
  assert.equal(final.status, 'exited'); assert.equal(final.exitCode, 3); assert.equal(final.output.trim(), 'got:hello');
  assert.throws(() => manager.write({ id: started.id, input: 'late' }), { code: 'process_not_running' });
});

test('large multi-byte output is spooled losslessly: the first result is a tail and cursors page everything', async t => {
  const { manager, project } = fixture(t);
  const result = await manager.run(project, { file: node, args: ['-e', "for(let i=0;i<4000;i++)console.log(String(i).padStart(5,'0')+' 中文✓'.repeat(6))"] });
  assert.equal(result.status, 'exited'); assert.ok(result.skippedBytes > 0, 'only the tail is returned first');
  assert.match(result.output, /03999 /); assert.equal(result.output.includes('�'), false);
  let cursor = 0, text = '';
  for (let pages = 0; pages < 100; pages++) {
    const page = await manager.read({ id: result.id, cursor, maxBytes: 7001 });
    assert.equal(page.output.includes('�'), false, 'a page never splits a UTF-8 character');
    text += page.output; cursor = page.cursor;
    if (!page.hasMore) break;
  }
  assert.equal(cursor, result.outputBytes);
  const lines = text.trim().split(/\r?\n/);
  assert.equal(lines.length, 4000); assert.equal(lines[0], '00000' + ' 中文✓'.repeat(6)); assert.equal(lines[3999], '03999' + ' 中文✓'.repeat(6));
  await assert.rejects(manager.read({ id: result.id, cursor: result.outputBytes + 1 }), { code: 'invalid_cursor' });
});

test('the kill timeout ends a command as timed_out and Job completion reports owned-child evidence', async t => {
  const { manager, project } = fixture(t);
  const slow = await manager.run(project, { file: node, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 1000, waitMs: 8000 });
  assert.equal(slow.status, 'timed_out');
  const done = await manager.complete(project, { file: node, args: ['-e', "process.stdout.write('job output');process.exit(2)"] });
  assert.equal(done.exitCode, 2); assert.equal(done.stdout, 'job output'); assert.equal(done.exitConfirmed, true); assert.equal(done.timedOut, false);
  await assert.rejects(manager.complete(project, { file: node, args: [], cwd: 'missing' }), error => error.notStarted === true);
  const controller = new AbortController();
  const running = manager.complete(project, { file: node, args: ['-e', "console.log('evidence');setInterval(()=>{},1000)"] }, { signal: controller.signal });
  await delay(400); controller.abort(Object.assign(new Error('requested'), { code: 'fixture_cancel' }));
  await assert.rejects(running, error => error.code === 'fixture_cancel' && error.termination.exitConfirmed === true && /evidence/.test(error.result.stdout));
});

test('service exposes shell and process tools with project scoping, model-facing text and precise hints', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shell-service-'));
  const rootA = path.join(temp, 'a'), rootB = path.join(temp, 'b'); fs.mkdirSync(rootA); fs.mkdirSync(rootB);
  const service = new DevMateService({ instanceRoot: path.join(temp, 'instance'), endpoint: '' });
  await service.ready;
  t.after(async () => { await service.close(); fs.rmSync(temp, { recursive: true, force: true }); });
  const owner = { id: 'owner', role: 'owner', surface: 'local' };
  const a = await service.call('project.create', { root: rootA, name: 'Alpha' }, owner);
  const b = await service.call('project.create', { root: rootB, name: 'Beta' }, owner);
  // A project may be named by id, by registered directory or by unique name.
  const byName = await service.call('shell.run', { projectId: 'Alpha', file: node, args: ['-e', "console.log('named')"] }, owner);
  assert.equal(byName.projectId, a.id); assert.equal(byName.exitCode, 0);
  const byRoot = await service.call('shell.run', { projectId: rootA, command: "node -e 'setInterval(()=>console.log(1),100)'", waitMs: 500 }, owner);
  assert.equal(byRoot.projectId, a.id); assert.equal(byRoot.status, 'running');
  await assert.rejects(service.call('shell.run', { projectId: path.join(temp, 'unregistered'), command: 'x' }, owner), { code: 'project_not_registered' });
  const memberOfB = { id: 'member-b', role: 'write', projectIds: [b.id] };
  await assert.rejects(service.call('process.read', { id: byRoot.id }, memberOfB), { code: 'forbidden' });
  await assert.rejects(service.call('process.stop', { id: byRoot.id }, memberOfB), { code: 'forbidden' });
  await assert.rejects(service.call('process.read', { id: byRoot.id }, { ...owner, projectId: b.id, windowId: 'w' }), { code: 'scope_mismatch' });
  assert.deepEqual((await service.call('process.list', { projectId: b.id }, memberOfB)).items, []);
  const shown = presentResult(service.operations.get('process.read'), await service.call('process.read', { id: byRoot.id }, owner));
  // The hint is a call that really waits: followed literally, it does not spin.
  assert.match(shown.content[0].text, /still running; process_read \{id:"process-[^"]+", cursor:\d+, waitMs:30000\} waits for more output/);
  // Command output is text for the model, sent once; the last line carries what is needed to continue.
  assert.equal(shown.structuredContent, undefined);
  const follow = JSON.parse(shown.content[0].text.split('\n').at(-1));
  assert.deepEqual([follow.id, follow.status, typeof follow.cursor], [byRoot.id, 'running', 'number']);
  // Removing the project stops what it owns.
  await service.call('project.remove', { id: a.id }, owner);
  assert.equal(alive(byRoot.pid), false);
  const hints = name => { const op = service.operations.get(name); return { destructive: op.destructive === true, openWorld: op.openWorld === true, readOnly: op.readOnly }; };
  assert.deepEqual(hints('shell.run'), { destructive: true, openWorld: true, readOnly: false });
  assert.deepEqual(hints('workspace.edit'), { destructive: false, openWorld: false, readOnly: false });
  assert.deepEqual(hints('workspace.delete'), { destructive: true, openWorld: false, readOnly: false });
  assert.deepEqual(hints('git.log'), { destructive: false, openWorld: false, readOnly: true });
});

test('output in the system encoding is read as text, line by line, beside UTF-8', async () => {
  const { decodeOutput } = await import('../runtime/processes.mjs');
  // "中文输出" as a program on a Chinese Windows writes it when its output is a pipe (GBK), between two UTF-8 lines.
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xca, 0xe4, 0xb3, 0xf6]);
  const mixed = Buffer.concat([Buffer.from('开始 ok\n'), gbk, Buffer.from('\n'), Buffer.from('结束 done\n')]);
  assert.equal(decodeOutput(mixed, 'gbk'), '开始 ok\n中文输出\n结束 done\n');
  // Valid UTF-8 is never reinterpreted, whatever the system encoding is.
  assert.equal(decodeOutput(Buffer.from('纯 UTF-8 输出 ✓\n'), 'gbk'), '纯 UTF-8 输出 ✓\n');
  // Bytes that are text in no encoding at all still come back as something, never as an error.
  assert.equal(typeof decodeOutput(Buffer.from([0x00, 0xff, 0xfe, 0x0a, 0x80])), 'string');
});

test('a long-running command that outlives its runtime is ended by the next one, and only that very process', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-leftover-'));
  const instanceRoot = path.join(temp, 'instance'), root = path.join(temp, 'project');
  fs.mkdirSync(root, { recursive: true });
  const project = { id: 'project-leftover', root, access: 'write', controlRoot: instanceRoot };
  // The runtime that started the command: it writes long runners down almost at once here.
  const first = createProcessManager({ instanceRoot, rememberAfterMs: 50 });
  const running = first.run(project, { file: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], waitMs: 0 });
  const started = await running, record = path.join(instanceRoot, 'owned-commands', started.id + '.json');
  t.after(() => { try { process.kill(started.pid, 'SIGKILL'); } catch {} fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; !fs.existsSync(record) && waited < 15000; waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).pid, started.pid); assert.equal(alive(started.pid), true);
  // A record of a process id that now belongs to something else: this very test process. It must be left alone.
  fs.writeFileSync(path.join(instanceRoot, 'owned-commands', 'process-other.json'), JSON.stringify({ pid: process.pid, identity: 'another program|long ago' }));
  // That runtime dies without stopping anything. Its successor finds the records.
  const second = createProcessManager({ instanceRoot });
  assert.deepEqual(await second.reapLeftovers(), { reaped: 1, found: 2 });
  assert.equal(alive(started.pid), false, 'the command the first runtime left behind is ended');
  assert.deepEqual(fs.readdirSync(path.join(instanceRoot, 'owned-commands')), []);
  // A command that ends on its own leaves no record behind.
  const short = await second.run(project, { file: process.execPath, args: ['-e', '1'], waitMs: 10000 });
  assert.equal(short.status, 'exited'); assert.deepEqual(fs.readdirSync(path.join(instanceRoot, 'owned-commands')).length, 0);
  await second.close();
});
