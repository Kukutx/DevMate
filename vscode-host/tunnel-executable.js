'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const resolutionCache = new Map();

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

module.exports = { resolveTunnelExecutable, windowsCandidates };
