import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeCommandProcessCount, commandEnvironment, executeCommand } from '../gateway/command-process.mjs';

test('normal commands preserve bounded output and exit metadata', async () => {
  const result = await executeCommand(process.execPath, ['-e', "process.stdout.write('abcdef')"], {
    timeoutMs: 5000,
    maxOutputChars: 4
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'cdef');
  assert.equal(result.stdoutTruncated, true);
});

test('Git commands are forced non-interactive because MCP commands have no stdin', () => {
  for (const command of [
    'git',
    'git.exe',
    '/usr/bin/git',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'git push origin master',
    '"C:\\Program Files\\Git\\cmd\\git.exe" push origin master'
  ]) {
    const env = commandEnvironment(command, {
      PATH: process.env.PATH || '',
      GIT_TERMINAL_PROMPT: '1',
      GCM_INTERACTIVE: 'Always'
    });
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GCM_INTERACTIVE, 'Never');
  }
  const nodeEnv = commandEnvironment(process.execPath, { SAMPLE: 'kept' });
  assert.equal(nodeEnv.SAMPLE, 'kept');
  assert.equal(nodeEnv.GIT_TERMINAL_PROMPT, undefined);
  assert.equal(nodeEnv.GCM_INTERACTIVE, undefined);
});

test('Git HTTP credential challenges fail promptly instead of hanging an MCP tool call', async t => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, {
      'www-authenticate': 'Basic realm="DevMate Git test"',
      'content-type': 'text/plain'
    });
    res.end('credentials required');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  const started = Date.now();
  const result = await executeCommand('git', ['ls-remote', `http://127.0.0.1:${port}/repo.git`], {
    timeoutMs: 5000,
    maxOutputChars: 4000
  });
  const elapsed = Date.now() - started;

  assert.equal(result.timedOut, false, result.stderr);
  assert.notEqual(result.exitCode, 0, result.stderr);
  assert.ok(elapsed < 4500, `credential failure took ${elapsed}ms and approached the command timeout`);
});

test('timeout terminates the complete owned process tree', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-command-tree-'));
  const marker = path.join(directory, 'grandchild-heartbeat');
  const childSource = "const fs=require('node:fs'); setInterval(() => fs.appendFileSync(process.argv[1], 'x'), 50);";
  const parentSource = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  try {
    const result = await executeCommand(process.execPath, ['-e', parentSource, marker], {
      timeoutMs: 250,
      maxOutputChars: 2000
    });
    assert.equal(result.timedOut, true);
    assert.equal(result.terminated, true);
    assert.equal(result.exitConfirmed, true);
    const sizeAfterReturn = fs.statSync(marker, { throwIfNoEntry: false })?.size || 0;
    await new Promise(resolve => setTimeout(resolve, 600));
    const sizeAfterSettling = fs.statSync(marker, { throwIfNoEntry: false })?.size || 0;
    assert.equal(sizeAfterSettling, sizeAfterReturn, 'grandchild activity continued after executeCommand returned');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('timeout force-stops a command that ignores graceful termination', async () => {
  const source = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  const result = await executeCommand(process.execPath, ['-e', source], {
    timeoutMs: 250,
    maxOutputChars: 2000
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.terminated, true);
  assert.equal(result.forced, true);
  assert.equal(result.exitConfirmed, true);
});

test('AbortSignal terminates the owned command tree before rejecting', async () => {
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel command test'), { code: 'test_cancelled' });
  const running = executeCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    timeoutMs: 10000,
    maxOutputChars: 2000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(reason), 100);
  await assert.rejects(running, error => error.code === 'test_cancelled');
  assert.equal(activeCommandProcessCount(), 0);
});
