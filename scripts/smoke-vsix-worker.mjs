#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const candidates = fs.readdirSync(root)
  .filter(name => /^devmate-.*\.vsix$/i.test(name))
  .map(name => ({ name, file: path.join(root, name), mtimeMs: fs.statSync(path.join(root, name)).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs);
if (!candidates.length) throw new Error('No packaged DevMate VSIX was found');

const vsix = candidates[0].file;
const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vsix-smoke-'));
const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vsix-workspace-'));
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vsix-state-'));
let router = null;
let vscodeController = null;
let obsidianController = null;

function extractArchive() {
  const tar = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', vsix, '-C', extractRoot], { encoding: 'utf8', windowsHide: true });
  if (tar.status === 0) return;
  if (process.platform === 'win32') {
    const zip = path.join(extractRoot, 'package.zip');
    fs.copyFileSync(vsix, zip);
    const escapedZip = zip.replace(/'/g, "''");
    const escapedTarget = extractRoot.replace(/'/g, "''");
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedTarget}' -Force`
    ], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0) return;
    throw new Error(`Could not extract VSIX. tar=${tar.stderr || tar.stdout}; powershell=${result.stderr || result.stdout}`);
  }
  const unzip = spawnSync('unzip', ['-q', vsix, '-d', extractRoot], { encoding: 'utf8' });
  if (unzip.status !== 0) throw new Error(`Could not extract VSIX: ${unzip.stderr || tar.stderr}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

try {
  extractArchive();
  const extensionPath = path.join(extractRoot, 'extension');
  const packageFile = path.join(extensionPath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(manifest.name, 'devmate');
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');

  const requiredFiles = [
    'extension-entry-shared-tunnel.js',
    'vscode-host/lifecycle.js',
    'vscode-host/gateway-spawn-router.js',
    'vscode-host/runtime-diagnostics.js',
    'vscode-host/spawn-layer.js',
    'vscode-host/bounded-http-client.js',
    'vscode-host/shared-tunnel-record-store.js',
    'vscode-host/shared-tunnel-process.js',
    'vscode-host/shared-tunnel-runtime.js',
    'host/runtime-controller.js',
    'shared/config-store.cjs',
    'host/runtime/diagnostics-store.js',
    'host/runtime/instance-lock-cleanup.js',
    'host/runtime/network.js',
    'host/runtime/operation-coordinator.js',
    'host/runtime/process-controller.js',
    'host/runtime/startup-lease.js',
    'host/runtime/worker-process.js',
    'gateway/server.bundle.mjs'
  ];
  for (const relative of requiredFiles) {
    const file = path.join(extensionPath, relative);
    assert.equal(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), true, `VSIX is missing ${relative}`);
  }

  const requireFromVsix = createRequire(packageFile);
  const { installGatewayWorkerRouter } = requireFromVsix('./vscode-host/gateway-spawn-router.js');
  const { RuntimeController } = requireFromVsix('./host/runtime-controller.js');
  const childProcessModule = { spawn() { throw new Error('Non-Gateway spawn should not be used in VSIX smoke test'); } };
  router = installGatewayWorkerRouter({
    childProcess: childProcessModule,
    extensionPath,
    diagnostics: { append() {}, recordFailure(error) { throw error; } }
  });

  const port = await freePort();
  const gatewayEntry = path.join(extensionPath, 'gateway', 'server.bundle.mjs');
  const controllerOptions = {
    workspaceRoot,
    stateDirectory,
    gatewayEntry,
    preferredPort: port,
    appVersion: manifest.version,
    nodeExecutable: process.execPath,
    spawnImpl: childProcessModule.spawn
  };
  vscodeController = new RuntimeController({ ...controllerOptions, hostId: 'vscode-artifact' });
  obsidianController = new RuntimeController({ ...controllerOptions, hostId: 'obsidian-artifact' });

  const [vscodeStart, obsidianStart] = await Promise.all([
    vscodeController.start({ timeoutMs: 20000 }),
    obsidianController.start({ timeoutMs: 20000 })
  ]);
  const starts = [vscodeStart, obsidianStart];
  assert.equal(starts.filter(result => result.started).length, 1, 'Exactly one packaged host must start the Gateway');
  assert.equal(starts.filter(result => result.attached).length, 1, 'The second packaged host must attach');
  assert.equal(router.snapshot().ownedCount, 1, 'Only one packaged Worker may exist for shared state');

  const owner = vscodeStart.started ? vscodeController : obsidianController;
  const follower = vscodeStart.started ? obsidianController : vscodeController;
  const instanceLock = path.join(stateDirectory, 'state', 'gateway.lock');
  const startupLock = path.join(stateDirectory, 'gateway.start.lock');
  const lock = JSON.parse(fs.readFileSync(instanceLock, 'utf8'));
  assert.equal(lock.runtimeOwnerId, owner.lastLaunch.ownerId);
  assert.equal(lock.launchMode, 'worker_threads');
  assert.ok(Number(lock.threadId) > 0);
  assert.equal(lock.pid, process.pid);
  assert.equal(fs.existsSync(startupLock), false, 'Startup lease must be released after convergence');

  const followerStop = await follower.stop();
  assert.equal(followerStop.stopped, false);
  assert.equal(followerStop.reason, 'managed-by-another-host');
  assert.equal((await owner.stop()).stopped, true);
  assert.equal(fs.existsSync(instanceLock), false, 'Owner stop must release the Gateway lock');
  assert.equal(router.snapshot().ownedCount, 0);

  const restarted = await owner.start({ timeoutMs: 20000 });
  assert.equal(restarted.started, true);
  assert.equal(router.snapshot().ownedCount, 1);
  assert.equal((await owner.stop()).stopped, true);
  assert.equal(fs.existsSync(instanceLock), false, 'Same-port restart must release the Gateway lock again');
  assert.equal(fs.existsSync(startupLock), false, 'Restart must release the startup lease');

  await follower.dispose();
  await owner.dispose();
  const routerResult = await router.dispose({ forceRestore: true });
  assert.equal(routerResult.stopped.exited, 0);
  router = null;

  console.log(JSON.stringify({
    ok: true,
    vsix: path.basename(vsix),
    version: manifest.version,
    launchMode: lock.launchMode,
    gateway: path.relative(extensionPath, gatewayEntry),
    concurrentHostsVerified: true,
    singleWorkerVerified: true,
    samePortRestartVerified: true,
    ownerLockVerified: true,
    spawnLayerPackaged: true
  }));
} finally {
  await vscodeController?.dispose({ stopOwned: true }).catch(() => {});
  await obsidianController?.dispose({ stopOwned: true }).catch(() => {});
  await router?.dispose({ forceRestore: true }).catch(() => {});
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
