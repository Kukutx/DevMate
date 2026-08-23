import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexAppServer, __test as runtimeTest } from '../gateway/agent-codex-runtime.mjs';

function fakeAppServer({ completeTurn = true, turnError = null } = {}) {
  const child = new EventEmitter();
  child.pid = 424242;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const requests = [];
  let buffer = '';
  const send = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  child.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      requests.push(message);
      if (!Object.hasOwn(message, 'id')) continue;
      if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: {} });
      if (message.method === 'thread/start') send({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } });
      if (message.method === 'turn/start') {
        send({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } });
        if (completeTurn) {
          setTimeout(() => {
            send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { turnId: 'turn-1', delta: 'proposal ready' } });
            send({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: {
                turn: {
                  id: 'turn-1',
                  status: turnError ? 'failed' : 'completed',
                  ...(turnError ? { error: turnError } : {})
                }
              }
            });
          }, 10);
        }
      }
      if (message.method === 'turn/interrupt') send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  });
  return { child, requests };
}

async function snapshotDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-codex-runtime-snapshot-'));
}

test('Codex app-server is parent-supervised, shell-free, deny-all, snapshot-scoped, network-off, and completes a bounded turn', async () => {
  const fake = fakeAppServer();
  const spawned = [];
  const cwd = await snapshotDir();
  const previousConfig = process.env.DEVMATE_CONFIG;
  process.env.DEVMATE_CONFIG = 'must-not-reach-codex';
  const codexExecutable = process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex';
  const runtime = new CodexAppServer({
    executable: codexExecutable,
    spawnFn(executable, args, options) {
      spawned.push({ executable, args, options });
      return fake.child;
    }
  });
  try {
    await runtime.start({ cwd });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].executable, process.execPath);
    assert.deepEqual(spawned[0].args, [runtimeTest.CODEX_SUPERVISOR_PATH]);
    assert.equal(spawned[0].options.shell, false);
    assert.deepEqual(spawned[0].options.stdio, ['pipe', 'pipe', 'pipe', 'ipc']);
    assert.equal(path.resolve(spawned[0].options.cwd), path.resolve(cwd));
    assert.equal(spawned[0].options.env.DEVMATE_CONFIG, undefined);
    assert.equal(spawned[0].options.env.DEVMATE_CODEX_SUPERVISOR_EXECUTABLE, codexExecutable);
    assert.deepEqual(JSON.parse(spawned[0].options.env.DEVMATE_CODEX_SUPERVISOR_ARGS), ['app-server', '--stdio']);

    const thread = await runtime.ensureThread({ cwd });
    assert.equal(thread.threadId, 'thread-1');
    const result = await runtime.runTurn({ threadId: thread.threadId, cwd, prompt: 'Make the requested isolated change.' });
    assert.equal(result.turnId, 'turn-1');
    assert.equal(result.status, 'completed');
    assert.match(result.output, /proposal ready/);

    const startThread = fake.requests.find(item => item.method === 'thread/start');
    assert.equal(path.resolve(startThread.params.cwd), path.resolve(cwd));
    assert.equal(startThread.params.approvalPolicy, 'never');
    assert.equal(startThread.params.sandbox, 'workspace-write');
    assert.match(startThread.params.developerInstructions, /isolated snapshot workspace/);

    const startTurn = fake.requests.find(item => item.method === 'turn/start');
    assert.equal(path.resolve(startTurn.params.cwd), path.resolve(cwd));
    assert.equal(startTurn.params.approvalPolicy, 'never');
    assert.deepEqual(startTurn.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [path.resolve(cwd)],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    });
    assert.equal(runtime.status().supervised, true);
    assert.equal(runtime.status().strongOsReadIsolation, false);
  } finally {
    fake.child.exitCode = 0;
    await runtime.stop();
    if (previousConfig === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previousConfig;
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('concurrent Codex stop calls share one process-tree termination', async () => {
  const fake = fakeAppServer();
  const cwd = await snapshotDir();
  let releaseTermination;
  const terminationGate = new Promise(resolve => { releaseTermination = resolve; });
  let terminationCalls = 0;
  const runtime = new CodexAppServer({
    executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex',
    spawnFn: () => fake.child,
    terminateFn: async child => {
      terminationCalls += 1;
      await terminationGate;
      child.exitCode = 0;
      return { terminated: true, forced: false, exitConfirmed: true };
    }
  });
  try {
    await runtime.start({ cwd });
    const first = runtime.stop();
    const second = runtime.stop();
    assert.equal(first, second);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(terminationCalls, 1);
    releaseTermination();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.deepEqual(firstResult, secondResult);
    assert.equal(firstResult.exitConfirmed, true);
    assert.equal(runtime.status().running, false);
  } finally {
    releaseTermination?.();
    fake.child.exitCode ??= 0;
    await runtime.stop();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('an active Codex turn fails immediately when the app-server transport closes', async () => {
  const fake = fakeAppServer({ completeTurn: false });
  const cwd = await snapshotDir();
  const runtime = new CodexAppServer({ executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex', spawnFn: () => fake.child });
  try {
    await runtime.start({ cwd });
    const thread = await runtime.ensureThread({ cwd });
    const started = Date.now();
    const turn = runtime.runTurn({
      threadId: thread.threadId,
      cwd,
      prompt: 'Wait for transport loss.',
      timeoutMs: 60_000,
      idleTimeoutMs: 60_000
    });
    setTimeout(() => {
      fake.child.exitCode = 1;
      fake.child.emit('close', 1, null);
    }, 20);
    await assert.rejects(turn, error => error?.code === 'codex_transport_closed');
    assert.ok(Date.now() - started < 2000, 'transport loss must not wait for idle/total timeout');
    assert.equal(runtime.listenerCount('transport-error'), 0);
    assert.equal(runtime.listenerCount('notification'), 0);
  } finally {
    fake.child.exitCode ??= 0;
    await runtime.stop();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('Codex environment is allowlisted and never inherits common credential variables', () => {
  const clean = runtimeTest.cleanEnvironment({
    PATH: '/safe/bin',
    HOME: '/safe/home',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C',
    CODEX_HOME: '/safe/codex',
    OPENAI_API_KEY: 'sk-secret',
    GITHUB_TOKEN: 'gh-secret',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    MY_PASSWORD: 'password',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    DEVMATE_CONFIG: '/secret/config.json',
    RANDOM_UNRELATED_VALUE: 'do-not-forward'
  });
  assert.equal(clean.PATH, '/safe/bin');
  assert.equal(clean.HOME, '/safe/home');
  assert.equal(clean.LANG, 'en_US.UTF-8');
  assert.equal(clean.LC_ALL, 'C');
  assert.equal(clean.CODEX_HOME, '/safe/codex');
  for (const key of ['OPENAI_API_KEY', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'MY_PASSWORD', 'SSH_AUTH_SOCK', 'DEVMATE_CONFIG', 'RANDOM_UNRELATED_VALUE']) {
    assert.equal(clean[key], undefined, key);
  }
  assert.equal(clean.GIT_TERMINAL_PROMPT, '0');
  assert.equal(clean.GCM_INTERACTIVE, 'Never');
});

test('Codex RPC diagnostic data is bounded and credential-redacted', () => {
  const safe = runtimeTest.sanitizeRpcData({ authorization: 'Bearer sk-supersecret', token: 'abc123', detail: 'ok' });
  assert.doesNotMatch(safe, /sk-supersecret|abc123/);
  assert.match(safe, /redacted/);
});

test('Codex completed turn errors are structurally credential-redacted', async () => {
  const fake = fakeAppServer({
    turnError: {
      authorization: 'Bearer sk-turn-supersecret',
      token: 'turn-secret-value',
      detail: 'synthetic failure'
    }
  });
  const cwd = await snapshotDir();
  const runtime = new CodexAppServer({
    executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex',
    spawnFn: () => fake.child
  });
  try {
    await runtime.start({ cwd });
    const thread = await runtime.ensureThread({ cwd });
    const result = await runtime.runTurn({ threadId: thread.threadId, cwd, prompt: 'Return a synthetic failure.' });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /redacted/);
    assert.match(result.error, /synthetic failure/);
    assert.doesNotMatch(result.error, /sk-turn-supersecret|turn-secret-value/);
  } finally {
    fake.child.exitCode = 0;
    await runtime.stop();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('Codex app-server refuses to start outside an explicit existing snapshot cwd', async () => {
  const fake = fakeAppServer();
  const runtime = new CodexAppServer({ executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex', spawnFn: () => fake.child });
  await assert.rejects(runtime.start(), error => error?.code === 'codex_snapshot_cwd_invalid');
  await assert.rejects(runtime.start({ cwd: path.join(os.tmpdir(), 'definitely-missing-devmate-codex-cwd') }), error => error?.code === 'codex_snapshot_cwd_invalid');
});

test('Codex steer enforces its bound even when called below the MCP schema layer', async () => {
  const fake = fakeAppServer();
  const cwd = await snapshotDir();
  const runtime = new CodexAppServer({ executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex', spawnFn: () => fake.child });
  try {
    await runtime.start({ cwd });
    await assert.rejects(runtime.steer('thread-1', 'turn-1', 'x'.repeat(20_001)), error => error?.code === 'codex_prompt_too_large');
  } finally {
    fake.child.exitCode = 0;
    await runtime.stop();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});

test('Codex server requests are explicitly rejected instead of hanging approval flow', async () => {
  const fake = fakeAppServer();
  const cwd = await snapshotDir();
  const runtime = new CodexAppServer({ executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex', spawnFn: () => fake.child });
  try {
    await runtime.start({ cwd });
    fake.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'item/commandExecution/requestApproval', params: {} })}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
    const reply = fake.requests.find(item => item.id === 99 && item.error);
    assert.ok(reply);
    assert.equal(reply.error.code, -32601);
  } finally {
    fake.child.exitCode = 0;
    await runtime.stop();
    await fsp.rm(cwd, { recursive: true, force: true });
  }
});