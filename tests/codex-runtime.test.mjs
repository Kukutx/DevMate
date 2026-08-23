import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexAppServer } from '../gateway/agent-codex-runtime.mjs';

function fakeAppServer() {
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
        setTimeout(() => {
          send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { turnId: 'turn-1', delta: 'proposal ready' } });
          send({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
        }, 10);
      }
      if (message.method === 'turn/interrupt') send({ jsonrpc: '2.0', id: message.id, result: {} });
    }
  });
  return { child, requests };
}

test('Codex app-server is shell-free, deny-all, snapshot-scoped, network-off, and completes a bounded turn', async () => {
  const fake = fakeAppServer();
  const spawned = [];
  const previousConfig = process.env.DEVMATE_CONFIG;
  process.env.DEVMATE_CONFIG = 'must-not-reach-codex';
  const runtime = new CodexAppServer({
    executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex',
    spawnFn(executable, args, options) {
      spawned.push({ executable, args, options });
      return fake.child;
    }
  });
  try {
    await runtime.start();
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ['app-server', '--stdio']);
    assert.equal(spawned[0].options.shell, false);
    assert.equal(spawned[0].options.env.DEVMATE_CONFIG, undefined);

    const cwd = process.platform === 'win32' ? 'C:\\devmate-state\\codex-task\\workspace' : '/tmp/devmate-state/codex-task/workspace';
    const thread = await runtime.ensureThread({ cwd });
    assert.equal(thread.threadId, 'thread-1');
    const result = await runtime.runTurn({ threadId: thread.threadId, cwd, prompt: 'Make the requested isolated change.' });
    assert.equal(result.turnId, 'turn-1');
    assert.equal(result.status, 'completed');
    assert.match(result.output, /proposal ready/);

    const startThread = fake.requests.find(item => item.method === 'thread/start');
    assert.equal(startThread.params.cwd, cwd);
    assert.equal(startThread.params.approvalPolicy, 'never');
    assert.equal(startThread.params.sandbox, 'workspace-write');
    assert.match(startThread.params.developerInstructions, /isolated snapshot workspace/);

    const startTurn = fake.requests.find(item => item.method === 'turn/start');
    assert.equal(startTurn.params.cwd, cwd);
    assert.equal(startTurn.params.approvalPolicy, 'never');
    assert.deepEqual(startTurn.params.sandboxPolicy, {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    });
    assert.equal(runtime.status().strongOsReadIsolation, false);
  } finally {
    fake.child.exitCode = 0;
    await runtime.stop();
    if (previousConfig === undefined) delete process.env.DEVMATE_CONFIG;
    else process.env.DEVMATE_CONFIG = previousConfig;
  }
});

test('Codex server requests are explicitly rejected instead of hanging approval flow', async () => {
  const fake = fakeAppServer();
  const runtime = new CodexAppServer({ executable: process.platform === 'win32' ? 'C:\\tools\\codex.exe' : '/usr/local/bin/codex', spawnFn: () => fake.child });
  try {
    await runtime.start();
    fake.child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'item/commandExecution/requestApproval', params: {} })}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
    const reply = fake.requests.find(item => item.id === 99 && item.error);
    assert.ok(reply);
    assert.equal(reply.error.code, -32601);
  } finally {
    fake.child.exitCode = 0;
    await runtime.stop();
  }
});
