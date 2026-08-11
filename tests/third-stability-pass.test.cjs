'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('awaited process shutdown deadlines remain referenced until they settle', () => {
  const processTree = source('host/runtime/process-tree.js');
  const waitStart = processTree.indexOf('function waitForChildExit');
  const waitEnd = processTree.indexOf('function runTaskkill', waitStart);
  assert.doesNotMatch(processTree.slice(waitStart, waitEnd), /timer\.unref/);
  const taskkillStart = waitEnd;
  const taskkillEnd = processTree.indexOf('async function terminateProcessTree', taskkillStart);
  const taskkill = processTree.slice(taskkillStart, taskkillEnd);
  assert.doesNotMatch(taskkill, /timer\.unref/);
  assert.match(taskkill, /killer\.off\?\.\('error', onError\)/);
  assert.match(taskkill, /killer\.off\?\.\('close', onClose\)/);
  assert.match(taskkill, /killer\.unref\?\.\(\)/);
});

test('retained shared tunnel controller stays registered and gets a real Stop retry before another activation', () => {
  const entry = source('extension-entry-shared-tunnel.js');
  const deactivateStart = entry.indexOf('async function deactivateInternal()');
  const deactivateEnd = entry.indexOf('function activate(context)', deactivateStart);
  const block = entry.slice(deactivateStart, deactivateEnd);
  assert.match(block, /if \(currentRuntime\) setTunnelController\(currentRuntime\)/);
  assert.match(block, /directStopResult = await currentRuntime\.stop\(\)/);
  const preserve = block.indexOf('if (disposed?.disposed === false)');
  const preserveRegistry = block.indexOf('setTunnelController(currentRuntime)', preserve);
  const clearRegistry = block.indexOf('clearTunnelController(currentRuntime)', preserve);
  assert.ok(preserveRegistry > preserve);
  assert.ok(clearRegistry > preserveRegistry);

  const activation = entry.slice(entry.indexOf('async function activateInternal(context)'), deactivateStart);
  assert.match(activation, /await deactivateInternal\(\)/);
  assert.match(activation, /DEVMATE_PREVIOUS_TUNNEL_TEARDOWN_PENDING/);
  assert.match(activation, /Shared tunnel cleanup after activation failure reported/);
});

test('blocked Obsidian state-directory switch leaves the old host bridge intact', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async reconfigureRuntimeInternal');
  const end = main.indexOf('scheduleReconfigure()', start);
  const block = main.slice(start, end);
  const gate = block.indexOf('if (!tunnelAllowsGatewayShutdown(previousTunnel))');
  const blockedThrow = block.indexOf("error.code = 'DEVMATE_OBSIDIAN_RECONFIGURE_BLOCKED'", gate);
  const bridgeStop = block.indexOf('await this.bridge?.stop()', blockedThrow);
  assert.ok(gate >= 0 && blockedThrow > gate && bridgeStop > blockedThrow);
  assert.doesNotMatch(block.slice(0, gate), /await this\.bridge\?\.stop\(\)/);
  assert.match(block, /} else \{\s*await this\.bridge\?\.stop\(\);\s*this\.bridge = null;/);
});
