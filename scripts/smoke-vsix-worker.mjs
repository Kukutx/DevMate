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

function extractArchive() {
  const tar = spawnSync(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', vsix, '-C', extractRoot], {
    encoding: 'utf8',
    windowsHide: true
  });
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

async function waitForHealth(healthAt, healthMatches, port, config, child) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const health = await healthAt(port, 1000);
    if (healthMatches(health, config)) return health;
    if (child.exitCode != null) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Packaged VSIX Gateway did not become ready; exit=${child.exitCode}; error=${child.lastError?.message || ''}`);
}

try {
  extractArchive();
  const extensionPath = path.join(extractRoot, 'extension');
  const packageFile = path.join(extensionPath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(manifest.name, 'devmate');
  assert.equal(manifest.main, './extension-entry-host.js');

  const requiredFiles = [
    'extension-entry-host.js',
    'vscode-host/lifecycle.js',
    'vscode-host/gateway-spawn-router.js',
    'vscode-host/runtime-diagnostics.js',
    'host/runtime/worker-process.js',
    'host/runtime/diagnostics-store.js',
    'gateway/server.bundle.mjs'
  ];
  for (const relative of requiredFiles) {
    const file = path.join(extensionPath, relative);
    assert.equal(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), true, `VSIX is missing ${relative}`);
  }

  const requireFromVsix = createRequire(packageFile);
  const { installGatewayWorkerRouter } = requireFromVsix('./vscode-host/gateway-spawn-router.js');
  const { ensurePersonalConfig } = requireFromVsix('./host/runtime-controller.js');
  const { healthAt, healthMatches } = requireFromVsix('./host/runtime/network.js');
  const childProcessModule = { spawn() { throw new Error('Non-Gateway spawn should not be used in VSIX smoke test'); } };
  const router = installGatewayWorkerRouter({
    childProcess: childProcessModule,
    extensionPath,
    diagnostics: { append() {}, recordFailure(error) { throw error; } }
  });

  const port = await freePort();
  const configFile = path.join(stateDirectory, 'config.json');
  const config = ensurePersonalConfig({
    configFile,
    workspaceRoot,
    preferredPort: port,
    appVersion: manifest.version
  });
  const gatewayEntry = path.join(extensionPath, 'gateway', 'server.bundle.mjs');
  const child = childProcessModule.spawn(process.execPath, [gatewayEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DEVMATE_CONFIG: configFile,
      DEVMATE_PUBLIC_HEALTH_DETAILS: '0'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  assert.equal(child.launchMode, 'worker_threads');
  const health = await waitForHealth(healthAt, healthMatches, port, config, child);
  assert.equal(health.json?.name, 'devmate');
  const exited = new Promise(resolve => child.once('exit', resolve));
  assert.equal(child.kill(), true);
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged VSIX Worker did not stop')), 5000))
  ]);
  router.dispose();

  console.log(JSON.stringify({
    ok: true,
    vsix: path.basename(vsix),
    version: manifest.version,
    launchMode: child.launchMode,
    gateway: path.relative(extensionPath, gatewayEntry),
    health: health.json?.status || 'ok'
  }));
} finally {
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
