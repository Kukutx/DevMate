'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { releaseOwnedHostRuntime } = require('../host/runtime/host-shutdown.js');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('host shutdown releases its owned tunnel and Gateway independently', async () => {
  const calls = [];
  const result = await releaseOwnedHostRuntime({
    stopTunnel: async () => {
      calls.push('tunnel');
      return { stopped: false, reason: 'managed-by-another-host' };
    },
    stopAuxiliary: async () => {
      calls.push('auxiliary');
      return { stopped: true, reason: 'terminated' };
    },
    stopGateway: async () => {
      calls.push('gateway');
      return { stopped: true, reason: 'terminated' };
    }
  });

  assert.deepEqual(calls, ['tunnel', 'auxiliary', 'gateway']);
  assert.equal(result.ok, true);
  assert.equal(result.detached, true);
  assert.equal(result.sharedStillActive, true);
  assert.equal(result.gateway.stopped, true);
});

test('Gateway release still runs when owned tunnel shutdown fails', async () => {
  const calls = [];
  const result = await releaseOwnedHostRuntime({
    stopTunnel: async () => {
      calls.push('tunnel');
      throw new Error('provider did not exit');
    },
    stopGateway: async () => {
      calls.push('gateway');
      return { stopped: true };
    }
  });

  assert.deepEqual(calls, ['tunnel', 'gateway']);
  assert.equal(result.ok, false);
  assert.equal(result.gateway.stopped, true);
  assert.match(result.tunnel.reason, /provider did not exit/);
});

test('attached host shutdown never destroys resources owned by another host', async () => {
  const result = await releaseOwnedHostRuntime({
    stopTunnel: async () => ({ stopped: false, reason: 'managed-by-another-host' }),
    stopGateway: async () => ({ stopped: false, attached: true, reason: 'managed-by-another-host' })
  });
  assert.equal(result.ok, true);
  assert.equal(result.sharedStillActive, true);
});

test('desktop host shutdown contract forbids preserve-by-orphan semantics', () => {
  const vscode = source('extension.js');
  const obsidian = source('obsidian-plugin/src/main.js');

  assert.match(vscode, /releaseOwnedHostRuntime/);
  assert.match(vscode, /host-deactivation-handoff/);
  assert.doesNotMatch(vscode, /host-deactivation-preserves-shared-session/);

  const unloadStart = obsidian.indexOf('async onunload()');
  const unloadEnd = obsidian.indexOf('async saveSettings()', unloadStart);
  const unload = obsidian.slice(unloadStart, unloadEnd);
  assert.match(unload, /releaseOwnedHostRuntime/);
  assert.match(unload, /this\.tunnelController\?\.stop\(\)/);
  assert.match(unload, /this\.controller\?\.stop\(\)/);
  assert.ok(unload.indexOf('this.tunnelController?.stop()') < unload.indexOf('this.tunnelController?.dispose'));
  assert.ok(unload.indexOf('this.controller?.stop()') < unload.indexOf('this.controller?.dispose'));
});

test('routine desktop context refresh cannot rewrite shared authentication policy', () => {
  const vscode = source('extension.js');
  const syncStart = vscode.indexOf('function syncConfig(');
  const syncEnd = vscode.indexOf('function scheduleContextRefresh', syncStart);
  const syncBlock = vscode.slice(syncStart, syncEnd);
  assert.doesNotMatch(syncBlock, /configureAuthentication\(/);

  const obsidian = source('obsidian-plugin/src/main.js');
  const reconfigureStart = obsidian.indexOf('async reconfigureRuntimeInternal');
  const reconfigureEnd = obsidian.indexOf('scheduleReconfigure()', reconfigureStart);
  const reconfigureBlock = obsidian.slice(reconfigureStart, reconfigureEnd);
  assert.doesNotMatch(reconfigureBlock, /configureAuthentication\(/);
  assert.match(obsidian, /async configureAuthenticationMode\(/);
});
