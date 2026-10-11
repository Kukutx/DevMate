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
const execute = (file, args) => new Promise(resolve => execFile(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 1 << 20 },
  (error, stdout, stderr) => resolve({ code: !error ? 0 : typeof error.code === 'number' ? error.code : -1, stdout: String(stdout || ''), stderr: String(stderr || '') })));
// The browsers that load Chrome extensions, and where each looks for hosts.
const WINDOWS_KEYS = { Chrome: 'Software\\Google\\Chrome\\NativeMessagingHosts\\', Edge: 'Software\\Microsoft\\Edge\\NativeMessagingHosts\\', Chromium: 'Software\\Chromium\\NativeMessagingHosts\\' };
const FOLDERS = {
  darwin: { Chrome: 'Library/Application Support/Google/Chrome', Edge: 'Library/Application Support/Microsoft Edge', Chromium: 'Library/Application Support/Chromium' },
  linux: { Chrome: '.config/google-chrome', Edge: '.config/microsoft-edge', Chromium: '.config/chromium' }
};

/**
 * The registry of the owner's account (HKEY_CURRENT_USER), read and written through Windows' own management service.
 * That is the registry every program sees. A program that runs inside a packaged app (a terminal in one, an agent
 * started from one) is given a private copy of HKCU\Software by the system: what reg.exe writes from there, no browser
 * ever reads, and what it reads back proves nothing. read answers the default value of each key, or null.
 */
function windowsRegistry({ env, run }) {
  const powershell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const quoted = value => '\'' + String(value).replace(/'/g, '\'\'') + '\'';
  async function ask(action, keys, value = '') {
    const script = ['$ErrorActionPreference = \'Stop\'',
      '$call = { param($method, $arguments) Invoke-CimMethod -Namespace root\\default -ClassName StdRegProv -MethodName $method -Arguments $arguments }',
      '$answers = foreach ($key in @(' + keys.map(quoted).join(', ') + ')) {',
      '  $at = @{ hDefKey = [uint32]2147483649; sSubKeyName = $key }',
      action === 'write' ? '  [void](& $call CreateKey $at); (& $call SetStringValue ($at + @{ sValueName = \'\'; sValue = ' + quoted(value) + ' })).ReturnValue'
        : action === 'remove' ? '  (& $call DeleteKey $at).ReturnValue'
        : '  $found = & $call GetStringValue ($at + @{ sValueName = \'\' }); if ($found.ReturnValue -eq 0) { [string]$found.sValue } else { $null }',
      '}',
      // Handed back in a form no console encoding can change.
      '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json @($answers) -Compress)))'].join('\n');
    const result = await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    let answers = null;
    try { answers = JSON.parse(Buffer.from(result.stdout.trim().split(/\s+/).pop() || '', 'base64').toString('utf8')); } catch { /* said below */ }
    if (result.code !== 0 || !Array.isArray(answers) || answers.length !== keys.length) throw fault('registration_failed', 'Windows did not let the registry of this account be ' + (action === 'read' ? 'read' : 'changed') + ' (PowerShell ended with code ' + result.code + ').');
    return answers;
  }
  return { read: keys => ask('read', keys), write: (keys, value) => ask('write', keys, value), remove: keys => ask('remove', keys) };
}

/**
 * The registration of one instance's browser host. cli is the DevMate command line it starts, node the program that
 * runs it; registry reads and writes the registry of the owner's account (Windows only). extension is the browser
 * extension this copy of DevMate carries (the folder beside its runtime).
 */
export function createChromeRegistration({ instanceRoot, cli, node = process.execPath, platform = process.platform, env = process.env, home = os.homedir(), run = execute, registry = windowsRegistry({ env, run }),
  extension = path.join(path.dirname(cli), '..', 'chrome-extension') } = {}) {
  const root = instanceDirectory(instanceRoot), directory = path.join(root, 'chrome'), windows = platform === 'win32';
  const shim = path.join(directory, windows ? 'devmate-chrome-host.cmd' : 'devmate-chrome-host'), manifest = path.join(directory, NATIVE_HOST + '.json'), note = path.join(directory, 'registration.json');
  // What the browser starts: a Node with a copy of DevMate, for this instance. The browser adds who is asking.
  const starts = (withNode, withCli) => windows
    ? '@echo off\r\n"' + withNode.replace(/%/g, '%%') + '" "' + withCli.replace(/%/g, '%%') + '" chrome-host --instance "' + root.replace(/%/g, '%%') + '" %*\r\n'
    : '#!/bin/sh\nexec \'' + [withNode, withCli, 'chrome-host', '--instance', root].map(word => word.replace(/'/g, '\'\\\'\'')).join('\' \'') + '\' "$@"\n';
  // What the browser loads. A browser remembers the folder it was given, so it is given one that stays where it is:
  // a copy in the instance directory, made the same as the extension this DevMate carries. An update through any
  // entry then reaches the browser, where the extension sees its files change and loads itself again. A newer
  // extension is never replaced by an older one: a runtime older than what the browser runs leaves it alone (the
  // extension's panel says that the runtime is the older of the two). The same version is this runtime's to set.
  const folder = path.join(directory, 'extension');
  const filesOf = (base, inside = '') => { try { return fs.readdirSync(path.join(base, inside), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesOf(base, path.join(inside, entry.name)) : entry.isFile() ? [path.join(inside, entry.name)] : []); } catch { return []; } };
  const versionOf = file => { try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).version ?? ''); } catch { return ''; } };
  const newer = (one, other) => { const left = one.split('.').map(Number), right = other.split('.').map(Number); for (let index = 0; index < Math.max(left.length, right.length); index++) { const gap = (left[index] || 0) - (right[index] || 0); if (gap) return gap > 0; } return false; };
  function carry() {
    const wanted = filesOf(extension);
    if (!wanted.includes('manifest.json') || newer(versionOf(path.join(folder, 'manifest.json')), versionOf(path.join(extension, 'manifest.json')))) return false;
    let changed = false;
    // The manifest last: until it is there, a browser that looks sees the extension it already runs.
    for (const name of [...wanted.filter(one => one !== 'manifest.json'), 'manifest.json']) {
      const content = fs.readFileSync(path.join(extension, name)), target = path.join(folder, name);
      let same = false; try { same = fs.readFileSync(target).equals(content); } catch { same = false; }
      if (same) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { mode: 0o644 });
      changed = true;
    }
    for (const name of filesOf(folder)) if (!wanted.includes(name)) { fs.rmSync(path.join(folder, name), { force: true }); changed = true; }
    return changed;
  }
  const description = JSON.stringify({ name: NATIVE_HOST, description: 'DevMate: the runtime on this computer, for the DevMate browser extension.', path: shim, type: 'stdio', allowed_origins: [EXTENSION_ORIGIN] }, null, 2) + '\n';
  const supported = windows || !!FOLDERS[platform];
  const browsers = Object.keys(WINDOWS_KEYS), keys = Object.values(WINDOWS_KEYS).map(key => key + NATIVE_HOST);
  // Elsewhere than on Windows a browser reads the file from its own folder: every browser that is installed gets one.
  const places = () => Object.entries(FOLDERS[platform] || {}).map(([browser, folder]) => ({ browser, base: path.join(home, folder), file: path.join(home, folder, 'NativeMessagingHosts', NATIVE_HOST + '.json') }));
  const unsupported = () => fault('unsupported', 'DevMate does not register a browser host on this system (' + platform + ').');
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  // Which Node and which copy of DevMate the browser starts, as noted when it was registered.
  const noted = () => { try { const value = JSON.parse(fs.readFileSync(note, 'utf8')); return typeof value?.node === 'string' && typeof value?.cli === 'string' ? value : null; } catch { return null; } };

  async function registered() {
    if (!windows) return places().filter(place => read(place.file) === description).map(place => place.browser);
    const values = await registry.read(keys);
    return browsers.filter((browser, index) => typeof values[index] === 'string' && values[index].toLowerCase() === manifest.toLowerCase());
  }
  // A registration that only this program's own view of the registry holds: written with reg.exe from inside a packaged
  // app, where no browser reads it. Asked of reg.exe, which answers from that view.
  const reg = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'reg.exe');
  async function apart() {
    const tail = manifest.split(/[^\x20-\x7e]/).pop().toLowerCase(), held = [];
    for (const key of keys) { const answer = await run(reg, ['query', 'HKCU\\' + key, '/ve']).catch(() => ({ code: -1, stdout: '' })); if (answer.code === 0 && answer.stdout.toLowerCase().includes(tail)) held.push(key); }
    return held;
  }
  /** ask:false is a quick look (the doctor's): the system is asked only where this instance has the files of a registration. */
  async function status({ ask = true } = {}) {
    if (!supported) return { registered: false, supported: false };
    const written = read(manifest) !== null && read(shim) !== null, programs = noted();
    const found = written || ask ? await registered() : [];
    // Written, and no browser can see it: said as what it is, because "registered" would be believed.
    if (windows && !found.length && written && ask && (await apart()).length) return { registered: false, supported: true, browsers: [], host: NATIVE_HOST, extension: EXTENSION_ORIGIN, unseen: true };
    // Registered with a Node or a copy of DevMate that is no longer there: the browser would start nothing.
    const stale = found.length > 0 && (!written || (programs !== null && (!fs.existsSync(programs.node) || !fs.existsSync(programs.cli))));
    return { registered: found.length > 0, supported: true, browsers: found, host: NATIVE_HOST, extension: EXTENSION_ORIGIN, ...(stale ? { stale: true } : {}), ...(fs.existsSync(path.join(folder, 'manifest.json')) ? { folder } : {}) };
  }
  /**
   * At a start of the runtime: what a registered browser starts and loads is made this copy of DevMate, so that an
   * update of DevMate needs nothing done in the browser. Only where the owner registered it; the system is asked nothing.
   * The Node it was registered with is kept (a runtime may itself be run by an editor's program, which is no Node to start).
   */
  function refresh() {
    if (!supported || read(manifest) === null) return { refreshed: false };
    const programs = noted(), kept = programs && fs.existsSync(programs.node) ? programs.node : null;
    let host = false;
    if (kept && read(shim) !== starts(kept, cli)) {
      fs.writeFileSync(shim, starts(kept, cli), { mode: 0o755 });
      fs.writeFileSync(note, JSON.stringify({ node: kept, cli }, null, 2) + '\n', { mode: 0o600 });
      host = true;
    }
    return { refreshed: true, host, extension: carry() };
  }
  async function install() {
    if (!supported) throw unsupported();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(shim, starts(node, cli), { mode: 0o755 });
    fs.writeFileSync(manifest, description, { mode: 0o644 });
    fs.writeFileSync(note, JSON.stringify({ node, cli }, null, 2) + '\n', { mode: 0o600 });
    carry();
    if (windows) {
      const outcome = await registry.write(keys, manifest), failed = browsers.filter((browser, index) => outcome[index] !== 0);
      if (failed.length) throw fault('registration_failed', 'Windows did not take the registration for ' + failed.join(', ') + '.');
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
    // Only what names this instance's file is taken away: a key another instance wrote is that instance's.
    if (windows) {
      const values = await registry.read(keys), mine = keys.filter((key, index) => typeof values[index] === 'string' && values[index].toLowerCase() === manifest.toLowerCase());
      if (mine.length) await registry.remove(mine);
      // And what an earlier registration left in this program's own view of the registry, where there is such a view.
      for (const key of await apart()) await run(reg, ['delete', 'HKCU\\' + key, '/f']).catch(() => {});
    }
    else for (const place of places()) if (read(place.file) === description || read(place.file)?.includes('"' + NATIVE_HOST + '"')) fs.rmSync(place.file, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
    return status();
  }
  return { status, install, uninstall, refresh, files: { shim, manifest, extension: folder } };
}
