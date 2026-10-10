'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'runtime', 'platform', 'command-process.mjs'), 'utf8');

test('Gateway command termination uses the bounded shared taskkill helper on Windows', () => {
  assert.match(source, /import processTreeRuntime from '\.\/process-tree\.js'/);
  assert.match(source, /runTaskkill: runBoundedTaskkill/);
  assert.match(source, /await runBoundedTaskkill\(child\.pid, true, spawn, Math\.max\(1000, forceMs\)\)/);
  assert.doesNotMatch(source, /async function runTaskkill\(/);
});

test('Gateway waitForExit removes alternate listeners when one terminal event settles', () => {
  const start = source.indexOf('function waitForExit(child)');
  const end = source.indexOf('function waitWithTimeout', start);
  const block = source.slice(start, end);
  assert.match(block, /child\.off\?\.\('close', onClose\)/);
  assert.match(block, /child\.off\?\.\('error', onError\)/);
});

test('a departed Windows parent is not proof of owned descendant termination', { skip: process.platform !== 'win32' }, async () => {
  const { terminateProcessTree } = await import('../runtime/platform/command-process.mjs');
  // No PID lookup or signal may be issued against an already departed parent:
  // its PID may have been reused by an unrelated process.
  const result = await terminateProcessTree({ pid: 12345, exitCode: 0, signalCode: null });
  assert.equal(result.exitConfirmed, false);
  assert.equal(result.terminated, false);
  assert.equal(result.reason, 'parent-exited-before-tree-confirmation');
});
