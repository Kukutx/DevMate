import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-local-capabilities-'));
const activeRoot = path.join(tempRoot, 'active');
const trustedRoot = path.join(tempRoot, 'trusted');
fs.mkdirSync(activeRoot, { recursive: true });
fs.mkdirSync(trustedRoot, { recursive: true });
const configPath = path.join(tempRoot, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  version: 11,
  appVersion: '1.16.0',
  activeWorkspaceId: 'active',
  workspaces: [{ id: 'active', name: 'active', root: activeRoot, mode: 'workspace-write', reference: false, role: 'active' }],
  permissions: { profile: 'fullAccess', readOnly: false, blockDangerousOperations: false, allowDirectoryMutations: true },
  runtime: { maxPersistentProcesses: 4, persistentProcessOutputBytes: 131072 },
  trustedWritableRoots: []
}, null, 2));
process.env.DEVMATE_CONFIG = configPath;

const moduleUrl = new URL('../gateway/local-capabilities.mjs', import.meta.url);
moduleUrl.searchParams.set('test', String(Date.now()));
const { installLocalCapabilities, shutdownPersistentProcesses } = await import(moduleUrl.href);
const sharedUrl = new URL('../gateway/local-shared.mjs', import.meta.url);
sharedUrl.searchParams.set('test', String(Date.now()));
const shared = await import(sharedUrl.href);

class FakeMcpServer {
  constructor() { this.tools = new Map(); }
  registerTool(name, config, handler) { this.tools.set(name, { config, handler }); }
  async connect() { return 'connected'; }
}
installLocalCapabilities(FakeMcpServer);
const server = new FakeMcpServer();
await server.connect();

async function call(name, args = {}) {
  const tool = server.tools.get(name);
  assert(tool, `missing tool ${name}`);
  return tool.handler(args);
}
function structured(result) { return result.structuredContent; }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

process.on('exit', () => { try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {} });

test('registers complete trusted-root and persistent-process tool surface', () => {
  for (const name of [
    'local_capabilities_status', 'configure_local_capabilities', 'list_trusted_roots', 'add_trusted_root', 'remove_trusted_root',
    'start_process', 'list_processes', 'process_status', 'read_process_output', 'send_process_input', 'stop_process'
  ]) assert(server.tools.has(name), `expected ${name}`);
});

test('local capability limits can be configured with bounded values', async () => {
  const configured = structured(await call('configure_local_capabilities', {
    maxPersistentProcesses: 3,
    persistentProcessOutputBytes: 262144
  }));
  assert.equal(configured.status.limits.maxProcesses, 3);
  assert.equal(configured.status.limits.outputBytes, 262144);
});

test('trusted writable root lifecycle is persisted and restored into workspaces', async () => {
  const added = structured(await call('add_trusted_root', { path: trustedRoot, name: 'External project' }));
  assert.equal(added.added, true);
  assert.equal(added.root.root, fs.realpathSync.native(trustedRoot));

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.trustedWritableRoots.length, 1);
  assert(config.workspaces.some(item => item.id === added.root.id && item.trusted === true));

  const listed = structured(await call('list_trusted_roots'));
  assert.equal(listed.roots.length, 1);
  assert.equal(listed.roots[0].id, added.root.id);

  await assert.rejects(() => call('add_trusted_root', { path: path.parse(trustedRoot).root }), /Filesystem roots cannot be trusted/);
});

test('persistent process supports output cursors, stdin, status, and clean exit', async () => {
  const trusted = structured(await call('list_trusted_roots')).roots[0];
  const scriptPath = path.join(trustedRoot, 'echo-process.cjs');
  fs.writeFileSync(scriptPath, [
    "process.stdin.setEncoding('utf8');",
    "console.log('ready');",
    "process.stdin.on('data', data => {",
    "  const text = data.trim();",
    "  console.log('echo:' + text);",
    "  if (text === 'quit') process.exit(0);",
    "});",
    "setInterval(() => {}, 1000);"
  ].join('\n'));
  const nodeCommand = `"${process.execPath.replace(/"/g, '\\"')}" echo-process.cjs`;
  const started = structured(await call('start_process', { workspaceId: trusted.id, command: nodeCommand, label: 'echo-test' }));
  const id = started.process.id;
  assert.equal(started.started, true);
  assert.equal(started.process.status, 'running');

  let first = null;
  for (let i = 0; i < 50; i++) {
    await delay(100);
    first = structured(await call('read_process_output', { id, afterSequence: 0, maxChars: 20000 }));
    if (first.events.some(event => event.text.includes('ready'))) break;
  }
  assert(first?.events.some(event => event.text.includes('ready')));
  assert(first.nextSequence > 0);

  await call('send_process_input', { id, input: 'hello' });
  let second = null;
  for (let i = 0; i < 50; i++) {
    await delay(100);
    second = structured(await call('read_process_output', { id, afterSequence: first.nextSequence, maxChars: 20000 }));
    if (second.events.some(event => event.text.includes('echo:hello'))) break;
  }
  assert(second?.events.some(event => event.text.includes('echo:hello')));
  assert.equal(second.missed, false);

  await call('send_process_input', { id, input: 'quit' });
  for (let i = 0; i < 30; i++) {
    await delay(100);
    const status = structured(await call('process_status', { id })).process;
    if (status.status === 'exited') break;
  }
  const finalStatus = structured(await call('process_status', { id })).process;
  assert.equal(finalStatus.status, 'exited');
  assert.equal(finalStatus.exitCode, 0);
});

test('trusted root removal refuses active processes unless explicitly stopping them', async () => {
  const trusted = structured(await call('list_trusted_roots')).roots[0];
  fs.writeFileSync(path.join(trustedRoot, 'wait-process.cjs'), 'setInterval(() => {}, 1000);\n');
  const nodeCommand = `"${process.execPath.replace(/"/g, '\\"')}" wait-process.cjs`;
  const started = structured(await call('start_process', { workspaceId: trusted.id, command: nodeCommand, label: 'wait-test' }));
  await assert.rejects(() => call('remove_trusted_root', { id: trusted.id }), /running processes/);
  const removed = structured(await call('remove_trusted_root', { id: trusted.id, stopProcesses: true }));
  assert.equal(removed.removed, true);
  assert(removed.stoppedProcesses.includes(started.process.id));
  const listed = structured(await call('list_trusted_roots'));
  assert.equal(listed.roots.length, 0);
});

test('persistent-process limits and dangerous command classification are bounded', () => {
  assert.deepEqual(shared.processLimits({ runtime: { maxPersistentProcesses: 999, persistentProcessOutputBytes: 1 } }), {
    maxProcesses: 32,
    outputBytes: 65536
  });
  for (const command of [
    'git reset --hard',
    'git reset --soft HEAD~1',
    'git restore .',
    'git checkout -- file.txt',
    'git checkout -B reset-branch',
    'git branch -D old-branch',
    'git switch -C reset-branch',
    'git push origin --delete old-branch',
    'git push --mirror origin'
  ]) assert.equal(shared.isDangerousCommand(command), true, command);
  for (const command of [
    'npm run dev',
    'git status --short',
    'git switch -c feature/safe',
    'git checkout -b feature/safe-2',
    'git branch -d merged-branch',
    'git clean -n'
  ]) assert.equal(shared.isDangerousCommand(command), false, command);
  assert.equal(shared.redactSensitiveString('token=placeholder-value'), 'token=redacted');
});

test('cleanup stops any remaining process trees', async () => {
  await shutdownPersistentProcesses();
  const listed = structured(await call('list_processes', { includeFinished: true }));
  assert(listed.processes.every(item => item.status !== 'running' && item.status !== 'stopping'));
  await fsp.rm(tempRoot, { recursive: true, force: true });
});