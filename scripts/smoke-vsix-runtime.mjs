#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const retiredSessionHeader = ['mcp', 'session', 'id'].join('-');
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

function localModuleSpecifiers(source) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s+(?:[^'"\x60]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]?.startsWith('.')) found.push(match[1]);
  }
  return found;
}

function resolveLocalModule(file, specifier) {
  const resolved = path.resolve(path.dirname(file), specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [resolved, `${resolved}.js`, `${resolved}.mjs`, `${resolved}.cjs`, `${resolved}.json`, path.join(resolved, 'index.js'), path.join(resolved, 'index.mjs'), path.join(resolved, 'index.cjs')];
  return candidates.find(candidate => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) || '';
}

function assertDependencyClosure(entryFile, extensionPath) {
  const queue = [entryFile];
  const visited = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of localModuleSpecifiers(source)) {
      const resolved = resolveLocalModule(file, specifier);
      assert.ok(resolved, `Packaged module missing: ${path.relative(extensionPath, file)} -> ${specifier}`);
      if (/\.(?:js|mjs|cjs)$/i.test(resolved)) queue.push(resolved);
    }
  }
  return visited;
}

function assertNoPrivateElectronNodeFlags(files) {
  const forbidden = ['--ms-enable-electron', 'run-as-node'].join('-');
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    assert.equal(source.includes(forbidden), false, `Unsupported private Electron Node flag packaged in ${file}`);
  }
}

try {
  extractArchive();
  const extensionPath = path.join(extractRoot, 'extension');
  const packageFile = path.join(extensionPath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(manifest.name, 'devmate');
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');
  const authenticationMode = manifest.contributes?.configuration?.properties?.['devMate.authenticationMode'];
  assert.equal(authenticationMode?.default, 'oauth', 'Packaged VSIX must default desktop MCP authentication to OAuth');
  assert.deepEqual(authenticationMode?.enum, ['none', 'oauth'], 'Packaged VSIX must retain explicit loopback no-auth and OAuth options');

  const requiredFiles = [
    'extension.js',
    'extension-entry-shared-tunnel.js',
    'vscode-host/lifecycle.js',
    'vscode-host/runtime-diagnostics.js',
    'vscode-host/shared-tunnel-record-store.js',
    'vscode-host/tunnel-controller.js',
    'vscode-host/tunnel-runtime.js',
    'host/public-mcp.js',
    'host/runtime-controller.js',
    'host/runtime/node-runtime.js',
    'shared/auth-config.cjs',
    'shared/oauth-secrets.cjs',
    'shared/oauth-tokens.cjs',
    'shared/config-store.cjs',
    'shared/connection-stability.cjs',
    'shared/public-ingress-verification.cjs',
    'host/runtime/diagnostics-store.js',
    'host/runtime/instance-lock-cleanup.js',
    'host/runtime/network.js',
    'host/runtime/operation-coordinator.js',
    'host/runtime/process-controller.js',
    'host/runtime/startup-lease.js',
    'gateway/agent-codex-supervisor.mjs',
    'gateway/server.bundle.mjs'
  ];
  for (const relative of requiredFiles) {
    const file = path.join(extensionPath, relative);
    assert.equal(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), true, `VSIX is missing ${relative}`);
  }

  const extensionSource = fs.readFileSync(path.join(extensionPath, 'extension.js'), 'utf8');
  const entryFile = path.join(extensionPath, manifest.main.replace(/^\.\//, ''));
  const codexSupervisorFile = path.join(extensionPath, 'gateway', 'agent-codex-supervisor.mjs');
  const dependencyFiles = new Set([
    ...assertDependencyClosure(entryFile, extensionPath),
    ...assertDependencyClosure(codexSupervisorFile, extensionPath)
  ]);
  assertNoPrivateElectronNodeFlags(dependencyFiles);
  assert.match(extensionSource, /resolveNodeRuntime/, 'VSIX must resolve a verified Node runtime before launching the Gateway');
  assert.match(extensionSource, /host\/runtime\/network\.js/, 'VSIX must use the shared Gateway health contract');
  assert.doesNotMatch(extensionSource, /runtime-io\.js|bounded-http-client\.js/, 'VSIX must not package retired private runtime adapters');
  assert.match(extensionSource, /const \{ verifySharedPublicMcp \} = require\('\.\/host\/shared-public-mcp-verification\.js'\)/, 'VSIX must link VS Code to shared cross-host public MCP verification');
  const verifyStart = extensionSource.indexOf('async function verifyCurrentTunnel');
  const verifyEnd = extensionSource.indexOf('async function quickStart', verifyStart);
  assert.ok(verifyStart >= 0 && verifyEnd > verifyStart, 'VSIX must package the shared public MCP verification entry');
  const verify = extensionSource.slice(verifyStart, verifyEnd);
  assert.match(verify, /return verifySharedPublicMcp\(\{/, 'VSIX verification must delegate to the shared single-flight verifier');
  assert.match(verify, /token: preflightAccessToken\(data, publicUrl, configPath\(ctx\)\)/, 'VSIX verification must derive an optional OAuth token from the selected authentication mode');

  const publicMcpSource = fs.readFileSync(path.join(extensionPath, 'host', 'public-mcp.js'), 'utf8');
  assert.match(publicMcpSource, /MCP_PROTOCOL_VERSION = '2026-07-28'/, 'VSIX shared preflight must pin MCP 2026-07-28');
  assert.match(publicMcpSource, /authorization: `Bearer \$\{String\(token\)\.trim\(\)\}`/, 'VSIX shared preflight must attach a short-lived OAuth token when one is supplied');
  assert.match(publicMcpSource, /mcpPayload\(1, 'server\/discover', \{\}, clientName, clientVersion\)/, 'VSIX shared preflight must send MCP 2026 server discovery metadata');
  assert.match(publicMcpSource, /protocolHeaders\('server\/discover', '', authHeaders\)/, 'VSIX shared preflight must bind server discovery to MCP 2026 wire headers');
  assert.match(publicMcpSource, /mcpPayload\(2, 'tools\/list', \{\}, clientName, clientVersion\)/, 'VSIX shared preflight must verify tools/list');
  assert.match(publicMcpSource, /protocolHeaders\('tools\/list', '', authHeaders\)/, 'VSIX shared preflight must bind tools/list to MCP 2026 wire headers');
  assert.match(publicMcpSource, /mcpPayload\(3, 'tools\/call', \{ name: PREFLIGHT_PROBE_TOOL, arguments: \{\} \}, clientName, clientVersion\)/, 'VSIX shared preflight must verify a real tool call');
  assert.match(publicMcpSource, /protocolHeaders\('tools\/call', PREFLIGHT_PROBE_TOOL, authHeaders\)/, 'VSIX shared preflight must bind the probe tool name to MCP 2026 wire headers');
  assert.match(publicMcpSource, /PREFLIGHT_PROBE_TOOL = 'gateway_status'/, 'VSIX shared preflight must probe the real gateway_status tool');
  assert.equal(publicMcpSource.toLowerCase().includes(retiredSessionHeader), false, 'VSIX shared preflight must remain stateless under MCP 2026');

  const gatewayBundleSource = fs.readFileSync(path.join(extensionPath, 'gateway', 'server.bundle.mjs'), 'utf8');
  assert.match(gatewayBundleSource, /legacy\s*:\s*["']reject["']/, 'Packaged Gateway must reject legacy MCP transport eras');

  const requireFromVsix = createRequire(packageFile);
  const { RuntimeController } = requireFromVsix('./host/runtime-controller.js');
  const { resolveNodeRuntime } = requireFromVsix('./host/runtime/node-runtime.js');
  const nodeRuntime = resolveNodeRuntime();
  const port = await freePort();
  const gatewayEntry = path.join(extensionPath, 'gateway', 'server.bundle.mjs');
  const controllerOptions = {
    workspaceRoot,
    stateDirectory,
    gatewayEntry,
    preferredPort: port,
    appVersion: manifest.version,
    nodeExecutable: nodeRuntime.executable
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
    sharedGatewayOwnershipVerified: true,
    isolatedProcessVerified: true,
    samePortRestartVerified: true,
    ownerLockVerified: true,
    oauthDefaultVerified: true,
    loopbackNoAuthOptionVerified: true,
    statelessMcp2026Verified: true,
    providerNativeConnectionRuntimePackaged: true,
    codexSupervisorPackaged: true,
    packagedDependencyClosureVerified: true,
    privateElectronFlagsAbsent: true
  }));
} finally {
  await vscodeController?.dispose({ stopOwned: true }).catch(() => {});
  await secondController?.dispose({ stopOwned: true }).catch(() => {});
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
