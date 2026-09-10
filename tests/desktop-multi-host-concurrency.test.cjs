'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  atomicWriteJson,
  newInstanceConfig,
  readJson
} = require('../shared/config-store.cjs');

const worker = path.join(__dirname, 'fixtures', 'host-registry-worker.cjs');

function runWorker(configFile, hostId, focused, workspaceRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, configFile, hostId, String(focused), workspaceRoot], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`host worker ${hostId} exited ${code}: ${stderr.trim()}`));
    });
  });
}

test('multiple desktop host processes converge without config corruption or policy loss', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-multi-host-'));
  const projectRoot = path.join(directory, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  const configFile = path.join(directory, 'config.json');
  const initial = newInstanceConfig({ workspaceRoot: projectRoot });
  initial.auth = { mode: 'oauth' };
  initial.permissions = {
    profile: 'balanced',
    readOnly: false,
    blockDangerousOperations: true,
    confirmBeforePush: true,
    allowDirectoryMutations: false
  };
  initial.hostRuntime.authenticationPolicyGeneration = 7;
  initial.hostRuntime.permissionPolicyGeneration = 9;
  atomicWriteJson(configFile, initial);

  const backgroundHosts = Array.from({ length: 8 }, (_, index) => ({
    id: index % 3 === 0 ? `obsidian-vault-${index}` : `vscode-project-${index}`,
    root: path.join(directory, `workspace-${index}`)
  }));
  await Promise.all(backgroundHosts.map(host => runWorker(configFile, host.id, false, host.root)));

  let config = readJson(configFile, null, { strict: true, supportedVersion: true });
  assert.ok(config);
  for (const host of backgroundHosts) assert.ok(config.hostContexts[host.id], `missing ${host.id}`);
  assert.equal(config.auth.mode, 'oauth');
  assert.equal(config.permissions.profile, 'balanced');
  assert.equal(config.permissions.confirmBeforePush, true);
  assert.equal(config.hostRuntime.authenticationPolicyGeneration, 7);
  assert.equal(config.hostRuntime.permissionPolicyGeneration, 9);

  const focusedId = 'vscode-focused-final';
  await runWorker(configFile, focusedId, true, path.join(directory, 'focused'));
  config = readJson(configFile, null, { strict: true, supportedVersion: true });

  assert.equal(Object.keys(config.hostContexts).length, backgroundHosts.length + 1);
  assert.equal(config.activeHostId, focusedId);
  assert.equal(config.hostRuntime.focusedHostId, focusedId);
  assert.equal(config.hostRuntime.lastInteractiveHostId, focusedId);
  assert.equal(config.auth.mode, 'oauth');
  assert.equal(config.hostRuntime.authenticationPolicyGeneration, 7);
  assert.equal(config.hostRuntime.permissionPolicyGeneration, 9);
});
