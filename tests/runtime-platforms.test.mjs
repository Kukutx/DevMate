import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { detectShell } from '../runtime/shell.mjs';
import { outdated, resolveTool, installHint, __test as tools } from '../runtime/platform/tools.mjs';
import { browserExecutableAllowed } from '../runtime/engines/browser-control-core.mjs';
import { lockEndpoint } from '../runtime/instance-lock.mjs';
import { main as cli } from '../runtime/cli.mjs';
const { completePath, usualDirectories } = createRequire(import.meta.url)('../runtime/platform/user-path.cjs');

// What differs between Windows, macOS and Linux is decided by small functions that take the platform
// as an argument, so the behaviour on the systems this suite is not running on is still pinned down.

test('a runtime started from a desktop icon still finds the tools a terminal would find', () => {
  const home = '/Users/dev';
  const installed = new Set(['/opt/homebrew/bin', '/usr/local/bin', home + '/.cargo/bin', home + '/.nvm/versions/node/v24.3.0/bin']);
  const options = { platform: 'darwin', home, exists: directory => installed.has(directory), list: () => ['v20.11.1', 'v24.3.0', 'v22.2.0', 'system'] };
  // The PATH macOS gives an application opened from the Dock.
  const dock = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home };
  assert.equal(completePath(dock, options).PATH, '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin:' + home + '/.cargo/bin:' + home + '/.nvm/versions/node/v24.3.0/bin');
  assert.equal(completePath(dock, options).HOME, home);
  // What is already there keeps its place and is not repeated; nothing that does not exist is added.
  const terminal = { PATH: '/opt/homebrew/bin:/usr/bin:/usr/local/bin:' + home + '/.cargo/bin:' + home + '/.nvm/versions/node/v24.3.0/bin' };
  assert.equal(completePath(terminal, options), terminal);
  assert.deepEqual(usualDirectories({ platform: 'linux', home: '/home/dev', list: () => { throw new Error('no nvm'); } }).slice(0, 4),
    ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin', '/snap/bin', '/home/dev/.local/bin']);
  const windows = { PATH: 'C:\\Windows' };
  assert.equal(completePath(windows, { platform: 'win32' }), windows, 'Windows gives every program the same PATH');
});

test('commands run in bash where there is one, because that is what gets written; plain sh is the fallback', () => {
  const has = (...files) => ({ exists: file => files.includes(file) });
  assert.deepEqual(detectShell({}, 'linux', has('/bin/bash', '/bin/sh')), { kind: 'sh', file: '/bin/bash', label: 'bash' });
  assert.deepEqual(detectShell({}, 'darwin', has('/opt/homebrew/bin/bash', '/bin/bash')), { kind: 'sh', file: '/bin/bash', label: 'bash' });
  assert.deepEqual(detectShell({}, 'linux', has('/usr/bin/bash')), { kind: 'sh', file: '/usr/bin/bash', label: 'bash' });
  assert.deepEqual(detectShell({}, 'linux', has()), { kind: 'sh', file: '/bin/sh', label: 'POSIX sh' }, 'a minimal container');
  assert.equal(detectShell(process.env, 'win32').kind, 'powershell');
});

test('a Git that is too old for the read-only tools is named with what to do, instead of every Git tool failing', () => {
  const says = text => () => text;
  tools.forget();
  // The Git of the macOS developer tools, and of Debian 12.
  const apple = outdated('git', '/usr/bin/git', says('git version 2.39.5 (Apple Git-154)\n'));
  assert.match(apple, /^Git 2\.39\.5 at \/usr\/bin\/git is too old: DevMate needs 2\.41 or newer\. Update Git/);
  tools.forget();
  assert.equal(outdated('git', '/usr/bin/git', says('git version 2.41.0\n')), null);
  tools.forget();
  assert.equal(outdated('git', 'C:\\Git\\git.exe', says('git version 2.51.1.windows.1\n')), null);
  tools.forget();
  assert.equal(outdated('git', '/usr/bin/git', () => { throw new Error('cannot run'); }), null, 'a version that cannot be read is not held against it');
  assert.equal(outdated('rg', '/usr/bin/rg', says('ripgrep 13.0.0')), null, 'only Git has a minimum');
  tools.forget();
  // The Git on this computer runs the suite, so it is new enough.
  assert.ok(path.isAbsolute(resolveTool('git')));
  assert.match(installHint('git'), process.platform === 'darwin' ? /brew install git/ : process.platform === 'win32' ? /winget install Git\.Git/ : /apt install git/);
});

test('the browsers of Linux and macOS are accepted under the names they have there', () => {
  for (const file of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
    '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Users/dev/Library/Caches/ms-playwright/chromium-1/chrome-mac/Chromium.app/Contents/MacOS/Google Chrome for Testing',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'])
    assert.equal(browserExecutableAllowed(file), true, file);
  for (const file of ['/usr/bin/firefox', '/usr/bin/google-chrome-wrapper.sh', '/bin/sh', 'C:\\Windows\\System32\\cmd.exe', '/usr/bin/chromedriver'])
    assert.equal(browserExecutableAllowed(file), false, file);
});

test('the instance lock is one fixed place per instance, also when the instance path is too long for a socket', { skip: process.platform === 'win32' && 'socket paths are a POSIX concern; Windows uses a named pipe' }, () => {
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  const deep = path.join(short, 'a'.repeat(60), 'b'.repeat(60));
  fs.mkdirSync(deep, { recursive: true });
  try {
    assert.equal(lockEndpoint(short), path.join(fs.realpathSync.native(short), 'runtime.sock'));
    const fallback = lockEndpoint(deep);
    assert.ok(fallback.startsWith(path.join(os.homedir(), '.devmate', 'run') + path.sep), 'not in the temp directory, which differs between a sandboxed editor and a terminal');
    assert.ok(Buffer.byteLength(fallback) < 100);
    assert.equal(lockEndpoint(deep), fallback);
  } finally { fs.rmSync(short, { recursive: true, force: true }); }
});

test('a project is removed by naming its directory through a link, the way it was typed', async t => {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-alias-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const real = path.join(temp, 'real'), alias = path.join(temp, 'alias');
  fs.mkdirSync(real); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const calls = [], out = [], err = [];
  // The runtime stores projects under their real path.
  const clientFactory = () => ({ call: async (operation, input) => { calls.push([operation, input]); return operation === 'project.list' ? { items: [{ id: 'project-1', name: 'real', root: real, access: 'write' }] } : { removed: true }; } });
  const code = await cli(['project', 'remove', alias], { clientFactory, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
  assert.equal(code, 0, err.join(''));
  assert.deepEqual(calls.at(-1), ['project.remove', { id: 'project-1' }]);
});
