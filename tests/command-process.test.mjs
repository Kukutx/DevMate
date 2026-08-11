
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeCommandProcessCount, executeCommand } from '../gateway/command-process.mjs';

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
