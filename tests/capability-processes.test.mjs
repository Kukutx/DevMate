import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createCapabilities } from '../runtime/capabilities.mjs';
import { DevMateService } from '../runtime/service.mjs';
import { browserQaPlugin } from '../runtime/engines/browser-qa.mjs';
import { engineEnvironment, engineEnvironmentAllows } from '../runtime/engines/engine-io.mjs';
import { finalGodotPlugin } from '../runtime/engines/godot-final.mjs';
import { engineEnvironment as reverseEngineEnvironment } from '../runtime/engines/reverse-engines.mjs';

// Engine processes are started through a real DevMateService and its real process manager.
const owner = Object.freeze({ id: 'owner', role: 'owner', surface: 'local' });
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-capability-processes-'));
const godot = path.join(shared, process.platform === 'win32' ? 'godot.exe' : 'godot');
fs.copyFileSync(process.execPath, godot);
fs.chmodSync(godot, 0o755);
test.after(() => fs.rmSync(shared, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
// Present in the runtime's own environment before the service captures it.
process.env.DEVMATE_FIXTURE_CREDENTIAL = 'must-not-reach-engine-children';
process.env.GODOT_FIXTURE_FLAG = 'toolchain';
process.env.JAVA_HOME ||= path.join(shared, 'jdk');

const report = "console.log(JSON.stringify({credential:process.env.DEVMATE_FIXTURE_CREDENTIAL??null,godot:process.env.GODOT_FIXTURE_FLAG??null,java:!!process.env.JAVA_HOME,extra:process.env.FIXTURE_EXTRA??null,path:!!(process.env.PATH||process.env.Path)}));";
const child = {
  manifest: { id: 'devmate.child', name: 'Child fixture', permissions: { executablePatterns: ['^node(?:\\.exe)?$'] } },
  activate(context) {
    const tool = (name, inputSchema, run) => context.server.registerTool(name, { inputSchema, annotations: { readOnlyHint: false } }, async args => context.toolText(await run(args)));
    tool('start', { script: z.string(), environment: z.record(z.string(), z.string()).optional(), autoStopAfterMs: z.number().optional() },
      ({ workspaceId, script, environment, autoStopAfterMs }) => context.executables.start(process.execPath, ['-e', script], { workspaceId, label: 'fixture child', environment, autoStopAfterMs }));
    tool('run', { script: z.string(), environment: z.record(z.string(), z.string()).optional() },
      ({ script, environment }) => context.executables.run(process.execPath, ['-e', script], { environment }));
    tool('start_missing', {}, ({ workspaceId }) => context.executables.start(path.join(shared, 'absent', 'node.exe'), [], { workspaceId, label: 'missing program' }));
    tool('start_other', {}, ({ workspaceId }) => context.executables.start(godot, ['--version'], { workspaceId }));
  }
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check, label, timeout = 8000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(shared, 'case-')), root = path.join(temp, 'project');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Processes"\n');
  const service = new DevMateService({ instanceRoot: path.join(temp, 'state'), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: () => ({}),
    config: { engineSettings: { godot: { executablePath: godot } } },
    capabilitiesFactory: options => createCapabilities({ ...options, engineSettings: { godot: options.engineSettings.godot }, engines: [browserQaPlugin, finalGodotPlugin, child] }) });
  t.after(() => service.close());
  const project = await service.call('project.create', { root }, owner);
  const op = (name, input = {}, context = owner) => service.call(name, input, context);
  const call = async (capability, input = {}, context = owner) => (await op('capability.call', { projectId: project.id, capability, input }, context)).structuredContent;
  return { root, service, project, op, call };
}

test('an engine process is an ordinary project process: listed, paged by cursor and stopped by the top-level operations', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const started = await f.call('child.start', { script: "let n=0;console.log('line '+n++);setInterval(()=>console.log('line '+n++),150);" });
  assert.match(started.id, /^process-/);
  assert.deepEqual([started.status, started.label, started.projectId], ['running', 'fixture child', f.project.id]);
  assert.equal(alive(started.pid), true);

  const listed = (await f.op('process.list', { projectId: f.project.id })).items;
  assert.deepEqual(listed.map(item => [item.id, item.label, item.status, item.shell]), [[started.id, 'fixture child', 'running', 'direct']]);
  const first = await until(async () => { const page = await f.op('process.read', { id: started.id, cursor: 0 }); return /line 1/.test(page.output) ? page : null; }, 'first output');
  assert.match(first.output, /^line 0\r?\nline 1/);
  // Reading from the returned cursor yields only what is new.
  const next = await f.op('process.read', { id: started.id, cursor: first.cursor, waitMs: 3000 });
  assert.equal(next.status, 'running');
  assert.ok(next.output.length > 0 && !next.output.includes('line 0\n') && !next.output.includes('line 0\r'));
  assert.ok(next.cursor > first.cursor);

  const stopped = await f.op('process.stop', { id: started.id });
  assert.equal(stopped.status, 'stopped');
  await until(() => !alive(started.pid), 'child exit');
  // The capability registry has no process tools of its own any more.
  for (const name of ['process.list', 'process.read', 'process.stop']) {
    await assert.rejects(f.op('capability.call', { projectId: f.project.id, capability: name, input: {} }), error => error.code === 'unknown_capability');
  }
});

test('godot.run hands back a process id that process_read and process_stop understand', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const run = await f.call('godot.run', { headless: true });
  assert.match(run.process.id, /^process-/);
  assert.equal(run.process.label, 'Godot game');
  assert.match(run.next, new RegExp('process\\.read \\{id:"' + run.process.id + '"\\}'));
  // The stand-in executable rejects Godot's arguments: the failure is visible through the top-level tools.
  const done = await until(async () => { const page = await f.op('process.read', { id: run.process.id, cursor: 0 }); return page.status === 'running' ? null : page; }, 'stand-in exit');
  assert.equal(done.status, 'exited');
  assert.notEqual(done.exitCode, 0);
  assert.match(done.output, /bad option|--headless/);
  assert.equal((await f.op('process.stop', { id: run.process.id })).status, 'exited');
  assert.equal((await f.op('capability.list', { projectId: f.project.id, name: 'godot.run' })).capability.description.includes('process.read'), true);
});

test('engine children inherit the toolchain allow-list and nothing else, however they are started', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const expected = { credential: null, godot: 'toolchain', java: true, extra: 'from-engine', path: true };
  const ran = await f.call('child.run', { script: report, environment: { FIXTURE_EXTRA: 'from-engine' } });
  assert.deepEqual(JSON.parse(ran.stdout), expected, 'short-lived child');
  const started = await f.call('child.start', { script: report, environment: { FIXTURE_EXTRA: 'from-engine' } });
  const page = await until(async () => { const value = await f.op('process.read', { id: started.id, cursor: 0 }); return value.status === 'running' ? null : value; }, 'report');
  assert.deepEqual(JSON.parse(page.output), expected, 'child started through the process manager');
  // An ordinary project command keeps the owner's environment: only engine children are reduced.
  const shell = await f.op('shell.run', { projectId: f.project.id, file: process.execPath, args: ['-e', report] });
  assert.equal(JSON.parse(shell.output).credential, 'must-not-reach-engine-children');

  // One list for every engine child, including the reverse backends and their scratch profile.
  for (const name of ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'DOTNET_ROOT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'GODOT_EXPORT_TEMPLATES_DIR', 'Path', 'SystemRoot']) assert.equal(engineEnvironmentAllows(name), true, name);
  for (const name of ['AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'CLOUDFLARE_TUNNEL_TOKEN', 'NODE_OPTIONS', 'PYTHONPATH', 'LD_PRELOAD', 'JAVA_TOOL_OPTIONS']) assert.equal(engineEnvironmentAllows(name), false, name);
  const source = { PATH: 'bin', DISPLAY: ':0', ANDROID_HOME: 'sdk', GODOT_SILENCE: '1', GITHUB_TOKEN: 'secret', HOME: 'profile' };
  assert.deepEqual(engineEnvironment({ EXTRA: 'x' }, source), { PATH: 'bin', DISPLAY: ':0', ANDROID_HOME: 'sdk', GODOT_SILENCE: '1', HOME: 'profile', EXTRA: 'x' });
  const scratch = reverseEngineEnvironment('scratch', source);
  assert.deepEqual([scratch.PATH, scratch.ANDROID_HOME, scratch.DISPLAY, scratch.HOME, scratch.GITHUB_TOKEN], ['bin', 'sdk', ':0', 'scratch', undefined]);
});

test('engine processes are bounded per project, refused without write access, and stopped when the project closes', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const wait = 'setInterval(()=>{},1000);';
  await assert.rejects(f.call('child.start_missing'), error => error.code === 'process_not_started' && /missing program could not be started/.test(error.message));
  await assert.rejects(f.call('child.start_other'), error => error.code === 'invalid_executable' && /child engine may not start godot/.test(error.message));
  const reader = { id: 'member', role: 'read', surface: 'mcp', projectIds: [f.project.id] };
  await assert.rejects(f.call('child.start', { script: wait }, reader), error => error.code === 'forbidden');

  const started = [];
  for (let index = 0; index < 8; index++) started.push(await f.call('child.start', { script: wait }));
  await assert.rejects(f.call('child.start', { script: wait }), error => error.code === 'capacity' && /8 engine processes/.test(error.message) && /process_stop/.test(error.message));
  await f.op('process.stop', { id: started[0].id });
  started.push(await f.call('child.start', { script: wait }));
  assert.equal((await f.op('process.list', { projectId: f.project.id })).items.filter(item => item.status === 'running').length, 8);

  // A short auto-stop ends the process by itself.
  await f.op('process.stop', { id: started[1].id });
  const brief = await f.call('child.start', { script: wait, autoStopAfterMs: 1000 });
  await until(async () => (await f.op('process.read', { id: brief.id })).status === 'timed_out', 'auto stop');

  await f.service.capabilities.closeProject(f.project.id);
  const after = (await f.op('process.list', { projectId: f.project.id })).items;
  assert.equal(after.filter(item => item.status === 'running').length, 0);
  await until(() => started.every(item => !alive(item.pid)), 'all engine children gone');
  await f.service.capabilities.reopenProject(f.project.id);
  assert.equal((await f.call('child.start', { script: wait })).status, 'running', 'the reopened project starts clean');
});
