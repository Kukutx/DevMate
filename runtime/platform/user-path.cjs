'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A program started from the Dock, a launcher or a desktop icon does not get
// the PATH of a terminal: on macOS it is /usr/bin:/bin:/usr/sbin:/sbin. The
// runtime is started by whichever entry comes first and then serves all of
// them, so the places where developer tools are usually installed are added,
// behind what is already there. Windows gives every program the same PATH.
function usualDirectories({ platform = process.platform, home = os.homedir(), list = directory => fs.readdirSync(directory) } = {}) {
  if (platform === 'win32') return [];
  const join = (...parts) => path.posix.join(home, ...parts);
  const personal = [join('.local/bin'), join('.volta/bin'), join('.cargo/bin'), join('.bun/bin'), join('.deno/bin'), join('.asdf/shims'),
    join(platform === 'darwin' ? 'Library/pnpm' : '.local/share/pnpm')];
  // nvm keeps one directory per Node version; the newest one stands in for "the Node this user installed".
  try {
    const versions = list(join('.nvm/versions/node')).filter(name => /^v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => { const [x, y] = [a, b].map(name => name.slice(1).split('.').map(Number)); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
    if (versions.length) personal.push(join('.nvm/versions/node', versions[0], 'bin'));
  } catch {}
  return platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/opt/local/bin', ...personal]
    : ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', ...personal];
}

/** The environment with the usual tool directories that exist and are missing from PATH appended to it. */
function completePath(env = process.env, { platform = process.platform, home, list,
  exists = directory => !!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory() } = {}) {
  if (platform === 'win32') return env;
  const current = String(env.PATH || '').split(':').filter(Boolean), present = new Set(current);
  const added = usualDirectories({ platform, home, list }).filter(directory => !present.has(directory) && exists(directory));
  return added.length ? { ...env, PATH: [...current, ...added].join(':') } : env;
}

module.exports = { completePath, usualDirectories };
