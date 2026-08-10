#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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
let runtimeAuth = null;

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

try {
  extractArchive();
  const extensionPath = path.join(extractRoot, 'extension');
  const packageFile = path.join(extensionPath, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');

  const requireFromVsix = createRequire(packageFile);
  const { TunnelController } = requireFromVsix('./vscode-host/tunnel-controller.js');
  const { setTunnelController, clearTunnelController } = requireFromVsix('./vscode-host/tunnel-runtime.js');

  const port = 18787;
  const publicUrl = 'https://packaged-shared-tunnel.example.test';
  const settings = () => ({
    provider: 'external',
    publicUrl,
    autoRestart: true,
    maxRestarts: 3
  });

  runtimeA = new TunnelController({
    stateDirectory,
    settings,
    hostId: 'packaged-vscode-a',
    heartbeatMs: 5000
  });
  runtimeB = new TunnelController({
    stateDirectory,
    settings,
    hostId: 'packaged-vscode-b',
    heartbeatMs: 5000
  });

  setTunnelController(runtimeA);
  const owner = await runtimeA.start(port);
  assert.equal(owner.owned, true);
  assert.equal(owner.attached, false);
  assert.equal(owner.publicUrl, publicUrl);

  clearTunnelController(runtimeA);
  setTunnelController(runtimeB);
  const follower = await runtimeB.start(port);
  assert.equal(follower.owned, false);
  assert.equal(follower.attached, true);
  assert.equal(follower.publicUrl, publicUrl);
  assert.deepEqual(await runtimeB.stop(), {
    stopped: false,
    reason: 'managed-by-another-host',
    publicUrl
  });
  assert.equal(runtimeA.status(port).running, true);

  clearTunnelController(runtimeB);
  setTunnelController(runtimeA);
  const stopped = await runtimeA.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(runtimeA.status(port).running, false);
  assert.equal(fs.existsSync(path.join(stateDirectory, 'tunnel.start.lock')), false);

  class FailingNgrokChild extends EventEmitter {
    constructor(output) {
      super();
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
      this.pid = 24001;
      this.exitCode = 1;
      this.signalCode = null;
      this.stderr.write(output);
      queueMicrotask(() => {
        this.emit('exit', 1, null);
        this.emit('close', 1, null);
      });
    }
    kill() { return true; }
  }

  const machineToken = 'packaged-machine-token-abcdefghijklmnopqrstuvwxyz';
  const previousMachineToken = process.env.NGROK_AUTHTOKEN;
  let spawnedMachineToken = '';
  process.env.NGROK_AUTHTOKEN = machineToken;
  const childProcess = {
    spawn(command, args, options) {
      spawnedMachineToken = String(options?.env?.NGROK_AUTHTOKEN || '');
      return new FailingNgrokChild(`ERROR: authentication failed ERR_NGROK_107 Your authtoken: ${machineToken}\n`);
    },
    spawnSync(command, args) {
      if (args[0] === 'version') return { status: 0, stdout: 'ngrok version 3.37.6\n', stderr: '', error: null };
      if (args[0] === 'config' && args[1] === 'check') {
        return { status: 0, stdout: 'Valid configuration file at C:\\Users\\test\\AppData\\Local\\ngrok\\ngrok.yml\n', stderr: '', error: null };
      }
      throw new Error(`Unexpected packaged ngrok preflight: ${args.join(' ')}`);
    }
  };
  runtimeAuth = new TunnelController({
    stateDirectory,
    settings: () => ({
      provider: 'ngrok',
      ngrokUseManagedAccount: false,
      ngrokUrl: 'https://packaged-auth.ngrok-free.app',
      autoRestart: false,
      maxRestarts: 0
    }),
    getSecrets: async () => ({}),
    childProcess,
    hostId: 'packaged-vscode-auth'
  });
  try {
    await assert.rejects(runtimeAuth.start(port), error => {
      assert.equal(error?.code, 'DEVMATE_NGROK_AUTHENTICATION');
      assert.match(error.message, /ERR_NGROK_107/);
      assert.doesNotMatch(error.message, new RegExp(machineToken));
      return true;
    });
    assert.equal(spawnedMachineToken, machineToken);
  } finally {
    if (previousMachineToken === undefined) delete process.env.NGROK_AUTHTOKEN;
    else process.env.NGROK_AUTHTOKEN = previousMachineToken;
  }

  console.log(JSON.stringify({
    ok: true,
    vsix: path.basename(vsix),
    version: manifest.version,
    providerNativeTunnelPackaged: true,
    concurrentTunnelHostsVerified: true,
    followerOwnershipVerified: true,
    ownerCleanupVerified: true,
    virtualNgrokApiRequired: false,
    ngrokMachineEnvironmentVerified: true,
    ngrokFailureDiagnosticsVerified: true
  }));
} finally {
  try { clearTunnelController(); } catch {}
  await runtimeAuth?.dispose({ stopOwned: true }).catch(() => {});
  await runtimeA?.dispose({ stopOwned: true }).catch(() => {});
  await runtimeB?.dispose({ stopOwned: false }).catch(() => {});
  fs.rmSync(extractRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
