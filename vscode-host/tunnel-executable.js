'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');

const resolutionCache = new Map();

function clearTunnelExecutableCache(name = '') {
  const prefix = String(name || '').trim();
  if (!prefix) {
    resolutionCache.clear();
    return;
  }
  for (const key of resolutionCache.keys()) {
    if (key.includes(`:${prefix}:`)) resolutionCache.delete(key);
  }
}

function cloudflaredInstallCommand(platform = process.platform, spawnSyncImpl = spawnSync) {
  const available = (command, args) => {
    const result = spawnSyncImpl(command, args, { encoding: 'utf8', windowsHide: true });
    return !result.error && result.status === 0;
  };
  if (platform === 'win32' && available('winget.exe', ['--version'])) {
    return {
      command: 'winget.exe',
      args: ['install', '--id', 'Cloudflare.cloudflared', '--exact', '--accept-source-agreements', '--accept-package-agreements'],
      label: 'winget'
    };
  }
  if (platform === 'darwin' && available('brew', ['--version'])) {
    return { command: 'brew', args: ['install', 'cloudflared'], label: 'Homebrew' };
  }
  return null;
}

function installCloudflared({
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  execFileImpl = execFile,
  timeoutMs = 180000
} = {}) {
  const installer = cloudflaredInstallCommand(platform, spawnSyncImpl);
  if (!installer) return Promise.resolve({ ok: false, reason: 'automatic-install-unavailable' });
  return new Promise(resolve => {
    execFileImpl(installer.command, installer.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: Math.max(30000, Number(timeoutMs) || 180000),
      maxBuffer: 2 * 1024 * 1024
    }, (error, stdout, stderr) => {
      clearTunnelExecutableCache('cloudflared');
      resolve({
        ok: !error,
        installer: installer.label,
        output: String(stdout || stderr || error?.message || '').trim()
      });
    });
  });
}

function windowsCandidates(name, env = process.env) {
  const executable = `${name}.exe`;
  return [
    env['ProgramFiles'],
    env['ProgramFiles(x86)']
  ].filter(Boolean).map(root => path.join(root, name, executable)).concat([
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', executable),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims', executable),
    env.ChocolateyInstall && path.join(env.ChocolateyInstall, 'bin', executable)
  ].filter(Boolean));
}

function resolveTunnelExecutable(name, configuredPath = '', {
  platform = process.platform,
  env = process.env,
  existsSync = fs.existsSync,
  spawnSyncImpl = spawnSync
} = {}) {
  const configured = String(configuredPath || '').trim();
  if (configured) return configured;
  const command = platform === 'win32' ? `${name}.exe` : name;
  if (platform !== 'win32') return command;
  const cacheable = env === process.env && existsSync === fs.existsSync && spawnSyncImpl === spawnSync;
  const cacheKey = `${platform}:${name}:${env.PATH || ''}`;
  if (cacheable && resolutionCache.has(cacheKey)) return resolutionCache.get(cacheKey);

  const located = spawnSyncImpl('where.exe', [command], {
    encoding: 'utf8',
    windowsHide: true
  });
  const pathEntry = String(located.stdout || '').split(/\r?\n/).map(value => value.trim()).find(Boolean);
  if (!located.error && located.status === 0 && pathEntry && existsSync(pathEntry)) {
    if (cacheable) resolutionCache.set(cacheKey, pathEntry);
    return pathEntry;
  }

  const resolved = windowsCandidates(name, env).find(candidate => existsSync(candidate)) || command;
  if (cacheable) resolutionCache.set(cacheKey, resolved);
  return resolved;
}

module.exports = {
  clearTunnelExecutableCache,
  cloudflaredInstallCommand,
  installCloudflared,
  resolveTunnelExecutable,
  windowsCandidates
};
