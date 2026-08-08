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
let vscodeController = null;
let secondController = null;

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
    'extension.js',
    'extension-entry-shared-tunnel.js',
    'vscode-host/lifecycle.js',
    'vscode-host/runtime-diagnostics.js',
    'vscode-host/bounded-http-client.js',
    'vscode-host/shared-tunnel-record-store.js',
    'vscode-host/tunnel-controller.js',
    'vscode-host/tunnel-runtime.js',
    'host/public-mcp.js',
    'host/runtime-controller.js',
    'host/runtime/node-runtime.js',
    'shared/config-store.cjs',
    'host/runtime/diagnostics-store.js',
    'host/runtime/instance-lock-cleanup.js',
    'host/runtime/network.js',
    'host/runtime/operation-coordinator.js',
    'host/runtime/process-controller.js',
    'host/runtime/startup-lease.js',
    'gateway/server.bundle.mjs'
  ];
  for (const relative of requiredFiles) {
    const file = path.join(extensionPath, relative);
    assert.equal(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), true, `VSIX is missing ${relative}`);
  }
  for (const retired of [
    'vscode-host/gateway-spawn-router.js',
    'host/runtime/worker-process.js',
    'vscode-host/shared-tunnel-process.js',
    'vscode-host/shared-tunnel-runtime.js'
  ]) {
    assert.equal(fs.existsSync(path.join(extensionPath, retired)), false, `VSIX must not package retired ${retired}`);
  }

  const extensionSource = fs.readFileSync(path.join(extensionPath, 'extension.js'), 'utf8');
  assert.match(extensionSource, /const \{ preflightPublicMcp \} = require\('\.\/host\/public-mcp\.js'\)/, 'VSIX must link VS Code to the shared public MCP preflight');
  const verifyStart = extensionSource.indexOf('async function verifyPublicMcp');
  const verifyEnd = extensionSource.indexOf('async function quickStart', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, 'VSIX must package the shared public MCP verification entry');
  const verify = extensionSource.slice(verifyStart, verifyEnd);
  assert.match(verify, /return preflightPublicMcp\(\{/, 'VSIX verification must delegate to the shared preflight helper');
  assert.match(verify, /token: data\?\.auth\?\.required === false \? '' : String\(data\?\.auth\?\.token \|\| ''\)/, 'VSIX verification must pass the current owner bearer token');

  const publicMcpSource = fs.readFileSync(path.join(extensionPath, 'host', 'public-mcp.js'), 'utf8');
  assert.match(publicMcpSource, /authorization: `Bearer \$\{String\(token\)\.trim\(\)\}`/, 'VSIX shared preflight must authenticate requests');
  assert.match(publicMcpSource, /'mcp-session-id'/, 'VSIX shared preflight must carry MCP session state');
  assert.match(publicMcpSource, /method: 'tools\/list'/, 'VSIX shared preflight must verify tools/list');

  const requireFromVsix = createRequire(packageFile);
  const { RuntimeController } = requireFromVsix('./host/runtime-controller.js');
  const port = await freePort();
  const gatewayEntry = path.join(extensionPath, 'gateway', 'server.bundle.mjs');
  const controllerOptions = {
    workspaceRoot,
    stateDirectory,
    gatewayEntry,
    preferredPort: port,
    appVersion: manifest.version,
    nodeExecutable: process.execPath
  };
  vscodeController = new RuntimeController({ ...controllerOptions, hostId: 'vscode-artifact' });
  secondController = new RuntimeController({ ...controllerOptions, hostId: 'second-artifact-host' });

  const [vscodeStart, secondStart] = await Promise.all([
    vscodeController.start({ timeoutMs: 20000 }),
    secondController.start({ timeoutMs: 20000 })
  ]);
  const starts = [vscodeStart, secondStart];
  assert.equal(starts.filter(result => result.started).length, 1, 'Exactly one packaged host must start the Gateway');
  assert.equal(starts.filter(result => result.attached).length, 1, 'The second packaged host must attach');

  const owner = vscodeStart.started ? vscodeController : secondController;
  const follower = vscodeStart.started ? secondController : vscodeController;
  const instanceLock = path.join(stateDirectory, 'state', 'gateway.lock');
  const startupLock = path.join(stateDirectory, 'gateway.start.lock');
  const lock = JSON.parse(fs.readFileSync(instanceLock, 'utf8'));
  assert.equal(lock.runtimeOwnerId, owner.lastLaunch.ownerId);
  assert.equal(lock.launchMode, 'child_process');
  assert.equal(lock.threadId, 0);
  assert.ok(Number(lock.pid) > 0);
  assert.notEqual(lock.pid, process.pid, 'Gateway must run in an isolated process');
  assert.equal(fs.existsSync(startupLock), false, 'Startup lease must be released after convergence');

  const followerStop = await follower.stop();
  assert.equal(followerStop.stopped, false);
  assert.equal(followerStop.reason, 'managed-by-another-host');
  assert.equal((await owner.stop()).stopped, true);
  assert.equal(fs.existsSync(instanceLock), false, 'Owner stop must release the Gateway lock');

  const restarted = await owner.start({ timeoutMs: 20000 });
  assert.equal(restarted.started, true);
  assert.equal(owner.lastLaunch.mode, 'child_process');
  assert.equal((await owner.stop()).stopped, true);
  assert.equal(fs.existsSync(instanceLock), false, 'Same-port restart must release the Gateway lock again');
  assert.equal(fs.existsSync(startupLock), false, 'Restart must release the startup lease');

  await follower.dispose();
  await owner.dispose();

  console.log(JSON.stringify({
    ok: true,
    vsix: path.basename(vsix),
    version: manifest.version,
    launchMode: lock.launchMode,
    gateway: path.relative(extensionPath, gatewayEntry),
    concurrentHostsVerified: true,
    isolatedProcessVerified: true,
    samePortRestartVerified: true,
    ownerLockVerified: true,
    publicMcpAuthContractVerified: true,
    providerNativeTunnelRuntimePackaged: true,
    retiredWorkerRuntimeExcluded: true,
    retiredTunnelRuntimeExcluded: true
  }));
} finally {
  await vscodeController?.dispose({ stopOwned: true }).catch(() => {});
  await secondController?.dispose({ stopOwned: true }).catch(() => {});
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
