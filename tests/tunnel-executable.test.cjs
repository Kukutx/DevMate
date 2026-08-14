'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const {
  cloudflaredInstallCommand,
  installCloudflared,
  resolveTunnelExecutable,
  windowsCandidates
} = require('../vscode-host/tunnel-executable.js');

test('explicit tunnel executable configuration wins without probing the machine', () => {
  let probes = 0;
  const configured = 'C:\\Tools\\cloudflared.exe';
  const result = resolveTunnelExecutable('cloudflared', configured, {
    platform: 'win32',
    existsSync() { probes += 1; return false; },
    spawnSyncImpl() { probes += 1; return { status: 1, stdout: '' }; }
  });
  assert.equal(result, configured);
  assert.equal(probes, 0);
});

test('Windows tunnel executable resolution prefers PATH', () => {
  const located = 'C:\\Tools\\cloudflared.exe';
  const result = resolveTunnelExecutable('cloudflared', '', {
    platform: 'win32',
    existsSync(candidate) { return candidate === located; },
    spawnSyncImpl(command, args) {
      assert.equal(command, 'where.exe');
      assert.deepEqual(args, ['cloudflared.exe']);
      return { status: 0, stdout: `${located}\r\n`, error: null };
    }
  });
  assert.equal(result, located);
});

test('Windows tunnel executable resolution finds standard installer locations', () => {
  const env = {
    'ProgramFiles': 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
    USERPROFILE: 'C:\\Users\\dev'
  };
  const expected = path.join(env['ProgramFiles(x86)'], 'cloudflared', 'cloudflared.exe');
  const result = resolveTunnelExecutable('cloudflared', '', {
    platform: 'win32',
    env,
    existsSync(candidate) { return candidate === expected; },
    spawnSyncImpl() { return { status: 1, stdout: '', error: null }; }
  });
  assert.equal(result, expected);
  assert.ok(windowsCandidates('cloudflared', env).includes(expected));
});

test('tunnel executable resolution keeps a portable command fallback', () => {
  assert.equal(resolveTunnelExecutable('ngrok', '', { platform: 'linux' }), 'ngrok');
  assert.equal(resolveTunnelExecutable('cloudflared', '', {
    platform: 'win32',
    env: {},
    existsSync() { return false; },
    spawnSyncImpl() { return { status: 1, stdout: '', error: null }; }
  }), 'cloudflared.exe');
});

test('cloudflared automatic install uses bounded platform-native package commands', async () => {
  const spawnSyncImpl = (command, args) => {
    assert.equal(command, 'winget.exe');
    assert.deepEqual(args, ['--version']);
    return { status: 0, error: null };
  };
  const installer = cloudflaredInstallCommand('win32', spawnSyncImpl);
  assert.equal(installer.label, 'winget');
  assert.deepEqual(installer.args, [
    'install', '--id', 'Cloudflare.cloudflared', '--exact',
    '--accept-source-agreements', '--accept-package-agreements'
  ]);

  const result = await installCloudflared({
    platform: 'win32',
    spawnSyncImpl,
    execFileImpl(command, args, options, callback) {
      assert.equal(command, 'winget.exe');
      assert.deepEqual(args, installer.args);
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout >= 30000);
      callback(null, 'installed', '');
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.installer, 'winget');
});

test('cloudflared automatic install fails closed when no supported package manager is available', async () => {
  const unavailable = () => ({ status: 1, error: null });
  assert.equal(cloudflaredInstallCommand('linux', unavailable), null);
  assert.deepEqual(await installCloudflared({ platform: 'linux', spawnSyncImpl: unavailable }), {
    ok: false,
    reason: 'automatic-install-unavailable'
  });
});

test('every VS Code connection entry uses the shared tunnel executable resolver', () => {
  const root = path.resolve(__dirname, '..');
  const base = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
  const ngrok = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');
  const shared = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  for (const source of [base, platform, ngrok, shared]) {
    assert.match(source, /resolveTunnelExecutable/);
  }
  assert.match(platform, /cloudflareCommandPath: resolveTunnelExecutable\('cloudflared'/);
  assert.match(platform, /ngrokCommandPath: resolveTunnelExecutable\('ngrok'/);
  assert.match(ngrok, /return resolveTunnelExecutable\('ngrok'/);
  assert.doesNotMatch(base, /result\.error \? 'MISSING'/);
});
