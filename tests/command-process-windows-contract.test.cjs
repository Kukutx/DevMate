'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'gateway', 'command-process.mjs'), 'utf8');

test('Gateway command termination uses the bounded shared taskkill helper on Windows', () => {
  assert.match(source, /import processTreeRuntime from '\.\.\/host\/runtime\/process-tree\.js'/);
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

test('failed command termination remains bounded and retains an unconfirmed child for later cleanup', () => {
  const start = source.indexOf("if (winner.type === 'timeout' || winner.type === 'aborted')");
  const end = source.indexOf("if (winner.type === 'aborted')", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /exit = await exitPromise/);
  assert.match(block, /exit = await waitWithTimeout\(exitPromise, 100\)/);
  assert.match(block, /if \(exit && !termination\.exitConfirmed\) termination = \{ \.\.\.termination, exitConfirmed: true \}/);
  assert.match(block, /if \(exit \|\| child\.exitCode != null \|\| child\.signalCode != null\) activeProcesses\.delete\(child\)/);
});
