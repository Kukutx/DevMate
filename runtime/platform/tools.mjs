import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const cache = new Map();

// Windows searches the working directory of a new process before PATH. A
// project can therefore ship a `git.exe` or `rg.exe` that would run instead of
// the real tool. This switch turns that search off for everything this process
// and its children start by bare name.
export function hardenExecutableSearch(env = process.env) {
  if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}

/** Find an executable on PATH only (never the working directory) and return its absolute path. */
export function findOnPath(name, env = process.env) {
  if (path.isAbsolute(name)) return fs.statSync(name, { throwIfNoEntry: false })?.isFile() ? name : null;
  // Native executables only: a .cmd or .bat shim cannot be started without a shell.
  const extensions = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const directory of (env.PATH || env.Path || '').split(path.delimiter)) {
    const clean = directory.replace(/^"|"$/g, '');
    if (!clean || !path.isAbsolute(clean)) continue;
    for (const extension of extensions) {
      const candidate = path.join(clean, name + extension);
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  return null;
}

// A tool that is missing from PATH may still be on this computer: editors ship
// their own ripgrep. An editor host on this computer offers that copy. It is used
// only when PATH has none and only while the file is still there, since an
// editor update moves it.
const OFFERABLE = new Set(['rg']);
const offered = new Map();
const usable = (name, file) => typeof file === 'string' && path.isAbsolute(file) &&
  path.basename(file).toLowerCase() === name + (process.platform === 'win32' ? '.exe' : '') &&
  !!fs.statSync(file, { throwIfNoEntry: false })?.isFile();

/** Accept an editor's own copy of a tool. Given a directory, the copy is remembered there for a start without an editor. */
export function offerTool(name, file, rememberIn) {
  if (!OFFERABLE.has(name) || !usable(name, file)) return false;
  if (offered.get(name) === file) return true;
  offered.set(name, file);
  if (rememberIn) {
    try { fs.writeFileSync(path.join(rememberIn, 'tools.json'), JSON.stringify(Object.fromEntries(offered), null, 2) + '\n', { mode: 0o600 }); } catch {}
  }
  return true;
}

/** Bring back the copies remembered in an instance directory. */
export function recallTools(directory) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(path.join(directory, 'tools.json'), 'utf8')); } catch { return; }
  for (const [name, file] of Object.entries(saved || {})) if (OFFERABLE.has(name) && usable(name, file)) offered.set(name, file);
}

/** How to get a missing tool, in the words of this operating system. */
export function installHint(name) {
  const [label, windows, mac, linux] = name === 'rg'
    ? ['ripgrep', 'winget install BurntSushi.ripgrep.MSVC', 'brew install ripgrep', 'apt install ripgrep (or your distribution\'s package)']
    : ['Git', 'winget install Git.Git', 'brew install git', 'apt install git (or your distribution\'s package)'];
  return 'Install ' + label + ', for example: ' + (process.platform === 'win32' ? windows : process.platform === 'darwin' ? mac : linux) + '. Then restart DevMate from a new terminal, or after restarting your editor, so it sees the new PATH.';
}

// The read-only Git tools read attributes from an empty tree so that nothing a repository configures can run
// (git --attr-source, Git 2.41). The Git that ships with macOS developer tools and with older distributions is
// older than that; it is named as the problem instead of every Git tool failing with "unknown option".
const MINIMUM = { git: [2, 41] };
const versions = new Map();
export function toolVersion(file, run = execFileSync) {
  if (!versions.has(file)) {
    let found = null;
    try { found = String(run(file, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).match(/(\d+)\.(\d+)(?:\.(\d+))?/); } catch {}
    versions.set(file, found ? found.slice(1, 4).map(part => Number(part || 0)) : null);
  }
  return versions.get(file);
}
/** Null when the tool is new enough or its version cannot be read; otherwise what is wrong, in one sentence. */
export function outdated(name, file, run) {
  const minimum = MINIMUM[name], version = minimum && toolVersion(file, run);
  if (!version || version[0] > minimum[0] || (version[0] === minimum[0] && version[1] >= minimum[1])) return null;
  return (name === 'git' ? 'Git ' : name + ' ') + version.join('.') + ' at ' + file + ' is too old: DevMate needs ' + minimum.join('.') + ' or newer. ' + installHint(name).replace(/^Install /, 'Update ');
}

/** Absolute path of a tool DevMate itself runs (git, rg). PATH is resolved once per PATH value. */
export function resolveTool(name, env = process.env) {
  const key = name + '\0' + (env.PATH || env.Path || '');
  if (!cache.has(key)) cache.set(key, findOnPath(name, env));
  const found = cache.get(key) || (usable(name, offered.get(name)) ? offered.get(name) : null);
  if (!found) {
    const error = new Error(name + ' was not found on PATH. ' + (name === 'rg' ? 'It is required to find and search files. ' : name === 'git' ? 'It is required for the Git tools. ' : '') + installHint(name));
    error.code = 'tool_missing';
    throw error;
  }
  const old = outdated(name, found);
  if (old) throw Object.assign(new Error(old), { code: 'tool_outdated' });
  return found;
}

export const __test = { forget: () => { offered.clear(); versions.clear(); } };
