import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { instanceDirectory } from '../client.mjs';
import { EXTENSION_ORIGIN, NATIVE_HOST } from '../chrome.mjs';
import { DomainError } from '../store.mjs';

// Telling the browsers on this computer which program the DevMate extension may talk to. That is what a browser
// calls a native messaging host: a small file that names the program and the one extension allowed to start it,
// put where the browser looks (a registry key of the owner's own account on Windows, a folder of theirs elsewhere).
// It is the owner's account alone, needs no administrator, and is taken away again with "devmate chrome uninstall".

const fault = (code, message) => new DomainError(code, message);
const execute = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 1 << 20 },
  (error, stdout, stderr) => resolve({ code: !error ? 0 : typeof error.code === 'number' ? error.code : -1, stdout: String(stdout || ''), stderr: String(stderr || '') })));
// The browsers that load Chrome extensions, and where each looks for hosts.
const WINDOWS_KEYS = { Chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\', Edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\', Chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\' };
const FOLDERS = {
  darwin: { Chrome: 'Library/Application Support/Google/Chrome', Edge: 'Library/Application Support/Microsoft Edge', Chromium: 'Library/Application Support/Chromium' },
  linux: { Chrome: '.config/google-chrome', Edge: '.config/microsoft-edge', Chromium: '.config/chromium' }
};

/**
 * The registration of one instance's browser host. cli is the DevMate command line it starts, node the program that
 * runs it; run starts the system's own tool (reg.exe) and answers { code, stdout, stderr }.
 */
export function createChromeRegistration({ instanceRoot, cli, node = process.execPath, platform = process.platform, env = process.env, home = os.homedir(), run = execute } = {}) {
  const root = instanceDirectory(instanceRoot), directory = path.join(root, 'chrome'), windows = platform === 'win32';
  const shim = path.join(directory, windows ? 'devmate-chrome-host.cmd' : 'devmate-chrome-host'), manifest = path.join(directory, NATIVE_HOST + '.json'), note = path.join(directory, 'registration.json');
  // What the browser starts: this Node with this copy of DevMate, for this instance. The browser adds who is asking.
  const program = windows
    ? '@echo off\r\n"' + node.replace(/%/g, '%%') + '" "' + cli.replace(/%/g, '%%') + '" chrome-host --instance "' + root.replace(/%/g, '%%') + '" %*\r\n'
    : '#!/bin/sh\nexec \'' + [node, cli, 'chrome-host', '--instance', root].map(word => word.replace(/'/g, '\'\\\'\'')).join('\' \'') + '\' "$@"\n';
  const description = JSON.stringify({ name: NATIVE_HOST, description: 'DevMate: the runtime on this computer, for the DevMate browser extension.', path: shim, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] }, null, 2) + '\n';
  const reg = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'reg.exe');
  const supported = windows || !!FOLDERS[platform];
  // Elsewhere than on Windows a browser reads the file from its own folder: every browser that is installed gets one.
  const places = () => Object.entries(FOLDERS[platform] || {}).map(([browser, folder]) => ({ browser, base: path.join(home, folder), file: path.join(home, folder, 'NativeMessagingHosts', NATIVE_HOST + '.json') }));
  const unsupported = () => fault('unsupported', 'DevMate does not register a browser host on this system (' + platform + ').');
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

  async function registered() {
    if (windows) {
      // reg.exe prints in the console's own encoding: the path is recognised by the part of it that is plain ASCII.
      const found = [], tail = manifest.split(/[^\x20-\x7e]/).pop().toLowerCase();
      for (const [browser, key] of Object.entries(WINDOWS_KEYS)) {
        const answer = await run(reg, ['query', key + NATIVE_HOST, '/ve']);
        if (answer.code === 0 && answer.stdout.toLowerCase().includes(tail)) found.push(browser);
      }
      return found;
    }
    return places().filter(place => read(place.file) === description).map(place => place.browser);
  }
  // Which Node and which copy of DevMate the browser starts, as noted when it was registered.
  const noted = () => { try { const value = JSON.parse(fs.readFileSync(note, 'utf8')); return typeof value?.node === 'string' && typeof value?.cli === 'string' ? value : null; } catch { return null; } };
  /** ask:false is a quick look (the doctor's): the system is asked only where this instance has the files of a registration. */
  async function status({ ask = true } = {}) {
    if (!supported) return { registered: false, supported: false };
    const written = read(manifest) !== null && read(shim) !== null, programs = noted();
    const browsers = written || ask ? await registered() : [];
    // Registered with a Node or a copy of DevMate that is no longer there: the browser would start nothing.
    const stale = browsers.length > 0 && (!written || (programs !== null && (!fs.existsSync(programs.node) || !fs.existsSync(programs.cli))));
    return { registered: browsers.length > 0, supported: true, browsers, host: NATIVE_HOST, extension: EXTENSION_ORIGIN, ...(stale ? { stale: true } : {}) };
  }
  async function install() {
    if (!supported) throw unsupported();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(shim, program, { mode: 0o755 });
    fs.writeFileSync(manifest, description, { mode: 0o644 });
    fs.writeFileSync(note, JSON.stringify({ node, cli }, null, 2) + '\n', { mode: 0o600 });
    if (windows) {
      for (const [browser, key] of Object.entries(WINDOWS_KEYS)) {
        const answer = await run(reg, ['add', key + NATIVE_HOST, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f']);
        if (answer.code !== 0) throw fault('registration_failed', 'Windows did not take the registration for ' + browser + ' (reg.exe ended with code ' + answer.code + '). Nothing else was changed.');
      }
    } else {
      // A browser that is not installed has no folder, and gets none; Chrome's is made so that there is always one.
      for (const place of places()) {
        if (place.browser !== 'Chrome' && !fs.existsSync(place.base)) continue;
        fs.mkdirSync(path.dirname(place.file), { recursive: true });
        fs.writeFileSync(place.file, description, { mode: 0o644 });
      }
    }
    return status();
  }
  async function uninstall() {
    if (!supported) throw unsupported();
    if (windows) {
      for (const key of Object.values(WINDOWS_KEYS)) if ((await run(reg, ['query', key + NATIVE_HOST, '/ve'])).code === 0) await run(reg, ['delete', key + NATIVE_HOST, '/f']);
    } else for (const place of places()) if (read(place.file) === description || read(place.file)?.includes('"' + NATIVE_HOST + '"')) fs.rmSync(place.file, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    return status();
  }
  return { status, install, uninstall, files: { shim, manifest } };
}
