#!/usr/bin/env node
// The extension in a real editor, used the way it is used with several windows open: two independent
// VS Code instances (separate profiles) and a second window in one of them start at the same moment, all
// with auto-start on and all pointing at one fresh DevMate instance directory on a free port. Nothing is
// clicked. Runs on the oldest VS Code the extension supports (engines.vscode), downloaded once into
// .vscode-test; DEVMATE_VSCODE_EXECUTABLE names an installed editor to use instead.
//
//   node scripts/test-vscode-host.mjs [extension directory]     default: this repository
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { runtimeStatus, stopRuntime } from '../runtime/launcher.mjs';
import { createRuntimeClient } from '../runtime/client.mjs';
import processTree from '../runtime/platform/process-tree.js';

const repo = path.resolve(import.meta.dirname, '..');
const extension = path.resolve(process.argv[2] || repo);
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines.vscode.replace(/^\D+/, '');
const code = process.env.DEVMATE_VSCODE_EXECUTABLE
  || await (await import('@vscode/test-electron')).downloadAndUnzipVSCode({ version, cachePath: path.join(repo, '.vscode-test') });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 150000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out: ' + label);
    await wait(500);
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vscode-host-'));
const instanceRoot = path.join(base, 'instance');
const folders = Object.fromEntries(['alpha', 'beta', 'gamma'].map(name => {
  const directory = path.join(base, 'work ' + name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'readme.md'), '# ' + name + '\n');
  return [name, directory];
}));
const done = path.join(base, 'done.flag'), change = path.join(base, 'change.flag');
const port = await freePort();
const editors = [];
// An editor started from inside another editor's terminal must come up as an editor, not as Node.
const { ELECTRON_RUN_AS_NODE: _unused, ...environment } = process.env;

function launch(role, folder, extra) {
  const profile = path.join(base, 'profile-' + role), out = path.join(base, 'result-' + role + '.json');
  fs.mkdirSync(path.join(profile, 'User'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'User', 'settings.json'), JSON.stringify({
    'devMate.runtimeInstanceDirectory': instanceRoot, 'devMate.runtimePort': port, 'devMate.nodeCommandPath': process.execPath, 'devMate.autoStart': true,
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none', 'window.restoreWindows': 'none', 'chat.disableAIFeatures': true
  }, null, 2));
  const child = spawn(code, [folder, '--extensionDevelopmentPath=' + extension, '--extensionTestsPath=' + path.join(repo, 'tests', 'vscode-host-real-suite.cjs'),
    '--user-data-dir=' + profile, '--extensions-dir=' + path.join(base, 'extensions-' + role), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    '--disable-updates', '--disable-gpu', '--new-window', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    env: { ...environment, DEVMATE_HOST_TEST_ROLE: role, DEVMATE_HOST_TEST_OUT: out, DEVMATE_HOST_TEST_DONE: done, DEVMATE_HOST_TEST_CHANGE: change, ...(extra ? { DEVMATE_HOST_TEST_EXTRA: extra } : {}) },
    stdio: 'ignore' });
  editors.push({ role, child, out, exited: new Promise(resolve => child.once('exit', resolve)) });
}

const client = createRuntimeClient({ instanceRoot });
const projects = async () => (await client.call('project.list', {})).items.map(item => ({ name: item.name, access: item.access })).sort((a, b) => a.name.localeCompare(b.name));
const reported = () => editors.map(editor => fs.existsSync(editor.out) ? JSON.parse(fs.readFileSync(editor.out, 'utf8')) : null);
let failure = null;
try {
  // Both editors start at the same moment; each tries to start the shared runtime.
  launch('primary', folders.alpha, folders.gamma);
  launch('secondary', folders.beta);
  const status = await until(async () => { const value = await runtimeStatus({ instanceRoot }); return value.running ? value : null; }, 'a runtime is running');
  assert.equal(status.record.port, port);
  // Three editor windows: two in the primary instance, one in the secondary.
  await until(async () => (await client.call('window.list', {})).items.length >= 3, 'three windows attached');
  const results = await until(async () => { const all = reported(); return all.every(Boolean) ? all : null; }, 'both editors reported');
  for (const result of results) {
    assert.equal(result.error, undefined, result.error);
    assert.ok(result.found && result.active, 'The extension did not activate in the ' + result.role + ' editor.');
    assert.ok(result.commands.includes('devMate.runtime.start') && result.commands.includes('devMate.runtime.registerFolder'));
    assert.equal(result.state.generation, status.record.generation, 'Every editor must have joined the one runtime.');
  }
  // Nobody has clicked anything: every opened folder is shared, read and write, by the default alone.
  const shared = await until(async () => { const items = await projects(); return items.length >= 3 ? items : null; }, 'three folders shared by default', 60000);
  assert.deepEqual(shared, ['work alpha', 'work beta', 'work gamma'].map(name => ({ name, access: 'write' })));
  // The owner then makes one folder read only from its window.
  fs.writeFileSync(change, 'go');
  const narrowed = await until(async () => { const items = await projects(); return items.some(item => item.access === 'read') ? items : null; }, 'one folder became read only', 60000);
  assert.deepEqual(narrowed, [{ name: 'work alpha', access: 'read' }, { name: 'work beta', access: 'write' }, { name: 'work gamma', access: 'write' }]);
  const listed = (await client.call('project.list', {})).items;
  const alpha = listed.find(item => item.name === 'work alpha'), beta = listed.find(item => item.name === 'work beta');
  await assert.rejects(client.call('workspace.write', { projectId: alpha.id, path: 'probe.txt', text: 'x' }), error => error.code === 'read_only');
  // The windows keep re-binding on their own timer; that must not undo the owner's choice.
  await wait(20000);
  assert.deepEqual(await projects(), narrowed);
  // Finding files needs ripgrep: from PATH, or the copy the editor ships when PATH has none.
  assert.deepEqual((await client.call('workspace.find', { projectId: beta.id, pattern: '*.md' })).items.map(item => item.path), ['readme.md']);
  const windows = await until(async () => { const { items } = await client.call('window.list', {}); return items.every(item => item.selectedProjectId) ? items : null; }, 'every window bound its shared folder', 60000);
  // Editor state of a shared window reaches the runtime.
  assert.ok((await client.call('editor.context', { projectId: windows[0].selectedProjectId })).attachedWindows >= 1);
  // The local MCP endpoint the editors advertise really answers.
  const protocol = '2026-07-28';
  const tools = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': protocol, 'mcp-method': 'tools/list' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': protocol, 'io.modelcontextprotocol/clientInfo': { name: 'host-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  assert.ok((await tools.json()).result.tools.length > 20);
  // Closing every editor leaves the shared runtime running.
  fs.writeFileSync(done, 'done');
  assert.deepEqual(await Promise.all(editors.map(editor => Promise.race([editor.exited, wait(60000).then(() => 'still running')]))), [0, 0]);
  await wait(1500);
  const after = await runtimeStatus({ instanceRoot });
  assert.ok(after.running && after.record.pid === status.record.pid, 'The runtime must outlive the editors that started it.');
} catch (error) {
  failure = error;
} finally {
  fs.writeFileSync(done, 'done');
  for (const editor of editors) if (editor.child.exitCode === null) { await Promise.race([editor.exited, wait(8000)]); if (editor.child.exitCode === null) await processTree.terminateProcessTree(editor.child); }
  await stopRuntime({ instanceRoot, timeoutMs: 20000 }).catch(error => { failure ||= error; });
  if (failure) {
    console.error(String(failure.stack || failure));
    console.error(JSON.stringify({ editors: reported() }, null, 2));
    try { console.error(fs.readFileSync(path.join(instanceRoot, 'runtime.log'), 'utf8').slice(-3000)); } catch {}
  }
  await wait(500);
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
if (failure) process.exit(1);
console.log(JSON.stringify({ ok: true, vscode: version, extension, windows: 3, runtimes: 1 }));
