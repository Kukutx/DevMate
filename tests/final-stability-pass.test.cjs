'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { childExited, runTaskkill } = require('../host/runtime/process-tree.js');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('ChildProcess.killed is never treated as confirmed process exit', () => {
  assert.equal(childExited({ killed: true, exitCode: null, signalCode: null }), false);
  assert.equal(childExited({ killed: false, exitCode: 0, signalCode: null }), true);
  const extension = source('extension.js');
  assert.match(extension, /startCommandProcess && !childExited\(startCommandProcess\)/);
  assert.doesNotMatch(extension, /startCommandProcess && !startCommandProcess\.killed/);
});

test('Windows taskkill helper has its own deadline and attempts to terminate a hung helper', async () => {
  let killerStopped = false;
  const spawnImpl = () => {
    const killer = new EventEmitter();
    killer.kill = () => { killerStopped = true; return true; };
    return killer;
  };
  const result = await runTaskkill(4242, false, spawnImpl, 25);
  assert.equal(result.ok, false);
  assert.equal(result.timeout, true);
  assert.equal(result.error, 'taskkill-timeout');
  assert.equal(killerStopped, true);
});

test('shared tunnel activation refuses to overwrite a controller left by incomplete teardown', () => {
  const entry = source('extension-entry-shared-tunnel.js');
  const start = entry.indexOf('async function activateInternal(context)');
  const end = entry.indexOf("output = vscode.window.createOutputChannel('DevMate Tunnel')", start);
  const block = entry.slice(start, end);
  assert.match(block, /await deactivateInternal\(\)/);
  assert.match(block, /if \(runtime \|\| lifecycle \|\| publicVerifier\)/);
  assert.match(block, /DEVMATE_PREVIOUS_TUNNEL_TEARDOWN_PENDING/);
});

test('Obsidian keeps controller settings bound to the state directory captured at construction', () => {
  const main = source('obsidian-plugin/src/main.js');
  assert.match(main, /tunnelSettings\(stateDirectory = this\.stateDirectory\(\)\)/);
  assert.equal((main.match(/settings: \(\) => this\.tunnelSettings\(stateDirectory\)/g) || []).length, 2);
});

test('Obsidian state-directory reconfigure and disable both gate Gateway shutdown on public ingress release', () => {
  const main = source('obsidian-plugin/src/main.js');
  const reconfigureStart = main.indexOf('async reconfigureRuntimeInternal');
  const reconfigureEnd = main.indexOf('scheduleReconfigure()', reconfigureStart);
  const block = main.slice(reconfigureStart, reconfigureEnd);
  const stateChange = block.indexOf('if (!sameState)');
  const oldGatewayDispose = block.indexOf('this.controller?.dispose({ stopOwned: true })', stateChange);
  const stateGate = block.indexOf('if (!tunnelAllowsGatewayShutdown(previousTunnel))', stateChange);
  assert.ok(stateGate >= 0 && oldGatewayDispose > stateGate);
  assert.match(block, /DEVMATE_OBSIDIAN_RECONFIGURE_BLOCKED/);

  const disabled = block.indexOf('if (!this.settings.enabled)');
  const disabledGate = block.indexOf('if (tunnelAllowsGatewayShutdown(stoppedTunnel))', disabled);
  const disabledGatewayStop = block.indexOf('this.controller?.stop()', disabled);
  assert.ok(disabledGate >= 0 && disabledGatewayStop > disabledGate);
});
