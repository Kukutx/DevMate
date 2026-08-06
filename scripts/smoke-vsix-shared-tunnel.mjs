#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const candidates = fs.readdirSync(root)
  .filter(name => /^devmate-.*\.vsix$/i.test(name))
  .map(name => ({ name, file: path.join(root, name), mtimeMs: fs.statSync(path.join(root, name)).mtimeMs }))
  .sort((a, b) => b.mtimeMs - a.mtimeMs);
if (!candidates.length) throw new Error('No packaged DevMate VSIX was found');

const vsix = candidates[0].file;
const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vsix-tunnel-'));
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-vsix-tunnel-state-'));
let runtimeA = null;
let runtimeB = null;
let actualChild = null;

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

class FakeProviderChild extends EventEmitter {
  constructor(pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  kill(signal = 'SIGTERM') {
    if (this.killed || this.exitCode != null) return true;
    this.killed = true;
    this.exitCode = 0;
    this.signalCode = signal;
    queueMicrotask(() => {
      this.emit('exit', 0, signal);
      this.emit('close', 0, signal);
    });
    return true;
  }
}

function providerRequest(virtualHttpRequest, publicUrl, port) {
  return (input, options, callback) => {
    let effectiveOptions = options;
    let effectiveCallback = callback;
    if (typeof options === 'function') {
      effectiveCallback = options;
      effectiveOptions = {};
    }
    const target = input instanceof URL ? input : new URL(String(input));
    const method = String(effectiveOptions?.method || 'GET').toUpperCase();
    if (target.pathname === '/api/tunnels' && method === 'GET') {
      return virtualHttpRequest({
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tunnels: [{
            name: 'packaged-provider',
            public_url: publicUrl,
            proto: 'https',
            config: { addr: `http://127.0.0.1:${port}` }
          }]
        }),
        onResponse: effectiveCallback
      });
    }
    if (target.pathname.startsWith('/api/tunnels/') && method === 'DELETE') {
      return virtualHttpRequest({ statusCode: 204, onResponse: effectiveCallback });
    }
    return virtualHttpRequest({ statusCode: 404, onResponse: effectiveCallback });
  };
}

function requestJson(httpModule, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpModule.request(url, { method }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: response.statusCode, json, text });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error('Timed out waiting for packaged tunnel condition')); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

try {
  extractArchive();
  const extensionPath = path.join(extractRoot, 'extension');
  const packageFile = path.join(extensionPath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');

  const requireFromVsix = createRequire(packageFile);
  const { SharedTunnelRuntime } = requireFromVsix('./vscode-host/shared-tunnel-runtime.js');
  const { atomicWriteJson } = requireFromVsix('./host/runtime/config-store.js');
  const { virtualHttpRequest } = requireFromVsix('./tunnel-provider.js');

  const port = 18787;
  const publicUrl = 'https://packaged-shared-tunnel.example.test';
  atomicWriteJson(path.join(stateDirectory, 'config.json'), {
    version: 11,
    appVersion: manifest.version,
    server: { port, mcpPath: '/mcp' }
  });

  let spawnCount = 0;
  const spawnProvider = () => {
    spawnCount += 1;
    actualChild = new FakeProviderChild(80000 + spawnCount);
    return actualChild;
  };
  const cpA = { spawn: spawnProvider };
  const cpB = { spawn: spawnProvider };
  const httpA = { request: providerRequest(virtualHttpRequest, publicUrl, port) };
  const httpB = { request: providerRequest(virtualHttpRequest, publicUrl, port) };
  const settings = () => ({
    provider: 'ngrok',
    publicUrl: '',
    ngrokUrl: '',
    ngrokCommandPath: '',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: '',
    deploymentMode: 'personal'
  });

  runtimeA = new SharedTunnelRuntime({
    stateDirectory,
    childProcess: cpA,
    http: httpA,
    settings,
    hostId: 'packaged-vscode-a',
    runtimeLeaseMs: 30000,
    heartbeatMs: 5000,
    attachedPollMs: 100
  }).install();
  runtimeB = new SharedTunnelRuntime({
    stateDirectory,
    childProcess: cpB,
    http: httpB,
    settings,
    hostId: 'packaged-vscode-b',
    runtimeLeaseMs: 30000,
    heartbeatMs: 5000,
    attachedPollMs: 100
  }).install();

  const processA = cpA.spawn('ngrok', ['http', String(port)], {});
  const processB = cpB.spawn('ngrok', ['http', String(port)], {});
  await waitFor(() => spawnCount === 1 && (processA.owned || processB.owned));
  const ownerRuntime = processA.owned ? runtimeA : runtimeB;
  const ownerHttp = processA.owned ? httpA : httpB;
  const followerHttp = processA.owned ? httpB : httpA;
  const ownerProcess = processA.owned ? processA : processB;
  const followerProcess = processA.owned ? processB : processA;

  const ownerProviderView = await requestJson(ownerHttp, 'http://127.0.0.1:4040/api/tunnels');
  assert.equal(ownerProviderView.status, 200);
  await waitFor(() => ownerRuntime.store.read()?.status === 'ready');

  const followerView = await requestJson(followerHttp, 'http://127.0.0.1:4040/api/tunnels');
  assert.equal(followerView.status, 200);
  assert.equal(followerView.json.tunnels[0].public_url, publicUrl);
  assert.equal(spawnCount, 1, 'Extracted VSIX must create only one provider process');

  const followerDelete = await requestJson(
    followerHttp,
    'http://127.0.0.1:4040/api/tunnels/devmate-shared-tunnel',
    'DELETE'
  );
  assert.equal(followerDelete.status, 204);
  assert.equal(actualChild.killed, false, 'Follower DELETE must not stop the packaged owner');

  followerProcess.kill();
  await waitFor(() => followerProcess.exitCode === 0);
  assert.equal(actualChild.killed, false, 'Follower process kill must not stop the packaged owner');

  ownerProcess.kill();
  await waitFor(() => actualChild.killed && !ownerRuntime.store.read());
  assert.equal(fs.existsSync(path.join(stateDirectory, 'tunnel.start.lock')), false);

  console.log(JSON.stringify({
    ok: true,
    vsix: path.basename(vsix),
    version: manifest.version,
    sharedTunnelPackaged: true,
    concurrentTunnelHostsVerified: true,
    singleProviderSpawnVerified: true,
    followerOwnershipVerified: true,
    ownerCleanupVerified: true
  }));
} finally {
  try { runtimeA?.suspendSpawn(); } catch {}
  try { runtimeB?.suspendSpawn(); } catch {}
  await runtimeA?.dispose({ stopOwned: true }).catch(() => {});
  await runtimeB?.dispose({ stopOwned: true }).catch(() => {});
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
