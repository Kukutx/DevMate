
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCommand } from '../gateway/command-process.mjs';

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
  const marker = path.join(directory, 'grandchild-survived');
  const childSource = "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'alive'), 1200); setInterval(() => {}, 1000);";
  const parentSource = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const result = await executeCommand(process.execPath, ['-e', parentSource, marker], {
    timeoutMs: 250,
    maxOutputChars: 2000
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.terminated, true);
  assert.equal(result.exitConfirmed, true);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(fs.existsSync(marker), false);
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
