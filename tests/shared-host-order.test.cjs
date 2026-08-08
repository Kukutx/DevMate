'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RuntimeController } = require('../host/runtime-controller.js');
const { updateConfig } = require('../shared/config-store.cjs');

function fixture() {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-host-order-workspace-'));
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-host-order-state-'));
  const gatewayEntry = path.join(workspaceRoot, 'fake-gateway.mjs');
  return { workspaceRoot, stateDirectory, gatewayEntry };
}

function controller(value, hostId, preferredPort) {
  return new RuntimeController({ ...value, hostId, preferredPort, appVersion: '3.3.0' });
}

test('Obsidian-first and VS-Code-first shared config both use the same ngrok connection default', () => {
  for (const order of [
    [['obsidian', 8787], ['vscode', 9999]],
    [['vscode', 8787], ['obsidian', 9999]]
  ]) {
    const value = fixture();
    try {
      const first = controller(value, order[0][0], order[0][1]);
      const created = first.ensureConfig();
      assert.deepEqual(created.connection, { provider: 'ngrok', publicUrl: '' });
      assert.equal(created.server.port, 8787);

      const second = controller(value, order[1][0], order[1][1]);
      const reused = second.ensureConfig();
      assert.deepEqual(reused.connection, created.connection);
      assert.equal(reused.server.port, 8787, 'a later host preference must not replace the shared active port');
      assert.equal(reused.instanceId, created.instanceId, 'both hosts must retain one shared Gateway identity');
      assert.equal(reused.auth.token, created.auth.token, 'both hosts must retain one shared owner credential');
    } finally {
      fs.rmSync(value.workspaceRoot, { recursive: true, force: true });
      fs.rmSync(value.stateDirectory, { recursive: true, force: true });
    }
  }
});

test('a later host never rewrites explicit shared connection or access capabilities', () => {
  const value = fixture();
  try {
    const obsidian = controller(value, 'obsidian', 8787);
    obsidian.ensureConfig();
    updateConfig(obsidian.configFile, config => {
      config.connection = { provider: 'external', publicUrl: 'https://team.example.test' };
      config.team.requireWorkspaceLeaseForWrites = true;
      return config;
    });

    const vscode = controller(value, 'vscode', 9999);
    const reused = vscode.ensureConfig();
    assert.deepEqual(reused.connection, { provider: 'external', publicUrl: 'https://team.example.test' });
    assert.equal(reused.team.requireWorkspaceLeaseForWrites, true);
    assert.equal(reused.server.port, 8787);
  } finally {
    fs.rmSync(value.workspaceRoot, { recursive: true, force: true });
    fs.rmSync(value.stateDirectory, { recursive: true, force: true });
  }
});
