import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from './store.mjs';
import { assertSafeWorkspaceRoot, assertSafeWorkspacePath, isSensitiveWorkspacePath } from './platform/sensitive-path-policy.mjs';
import { executeCommand } from './platform/command-process.mjs';
import { resolveTool } from './platform/tools.mjs';
import { replaceFile } from './platform/atomic-write.mjs';
import { parsePatch, patchText } from './patch.mjs';

const WINDOWS = process.platform === 'win32';
const CASE_INSENSITIVE = WINDOWS || process.platform === 'darwin';
const gitNull = WINDOWS ? 'NUL' : '/dev/null';
// Git's well-known empty tree: reading attributes from it means no repository
// .gitattributes can attach a filter, textconv or external diff driver.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20000;
// One page of text for a model. Clients refuse a tool result much larger than this (Claude: about 150,000 characters).
// A page of a file is counted as it is shown, each line with its number.
const READ_CHAR_LIMIT = 120000;
const LINE_NUMBER_CHARS = 8;
// The owner's own workbench on this computer is not a model's client: it shows a file as it is, and edits larger ones.
const LOCAL_READ_CHAR_LIMIT = 256000;
// Text files up to this size are read (a page at a time) and searched; editing has the smaller limit of MAX_FILE_BYTES.
const READ_FILE_BYTES = 32 * 1024 * 1024;
const BLAME_CHAR_LIMIT = 120000;
const READ_LINE_LIMIT = 2000;
const DIFF_CHAR_LIMIT = 120000;
const DELETE_SNAPSHOT_FILES = 2000;
const DELETE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HISTORY_EVENTS = ['workspace.file.written', 'workspace.file.removed', 'workspace.file.moved'];
// How many changes one call takes back.
const TAKE_BACK_EVENTS = 5000;
// Dependency and build output that find/search skip unless includeIgnored is set.
const skippedDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'coverage']);
const unlistable = new Set(['unsafe_path', 'unsafe_file', 'outside_project', 'invalid_path', 'protected_workspace_path', 'protected_instance_path', 'not_found']);
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replace(/\\/g, '/');
const error = (code, message, details) => new DomainError(code, message, details);
// On Windows a file another program has open for a moment (a virus scanner or an indexer, right after a file is
// written) cannot be replaced, moved or deleted until it is let go. These calls hold the runtime up while they
// wait. So for a caller that tries again by itself (quickly(), which the operations use: operations/files.mjs) it is
// tried a few times at once and no more, and the refusal is then said as what it is, apart from every other fault:
// the caller makes the whole change again with the runtime free in between. Any other caller gets the long wait of
// replaceFile and the system's own error.
const HELD = ['EPERM', 'EBUSY', 'EACCES'], QUICK_REPEATS = 4;
const busy = rel => error('file_busy', 'Windows does not let ' + rel + ' be changed right now: another program has it open (a virus scanner or an indexer does that for a moment after a file is written). It was left as it is. Try again in a moment.');
// A file marked read-only is refused for good, not for a moment.
const writableFile = full => { try { fs.accessSync(full, fs.constants.W_OK); return true; } catch { return false; } };
// On Windows that mark means the file is not to be changed, and Windows itself replaces no such file by another
// that is renamed over it. Moved aside it could be: it is refused before that is tried.
const readOnlyFile = rel => error('read_only_file', rel + ' is marked read-only and was left as it is. Take the mark off, with a command, to change it.');
const keptReadOnly = (rel, full) => { if (WINDOWS && fs.existsSync(full) && !writableFile(full)) throw readOnlyFile(rel); };
// A file that was moved out of the way and could be neither replaced nor put back: nothing is under its name, and
// what it held is beside it under a working copy's name, which no listing shows. Said with that name, so that it is found.
const displaced = (rel, aside) => Object.assign(error('file_displaced', rel + ' could not be replaced, and could not be put back where it was: there is no file under that name now. What it held is in ' +
  path.basename(aside) + ' in the same folder, a name the file tools do not list. Move it back with a command (for example: mv), then try the change again.', { heldIn: path.basename(aside) }), { incomplete: true });
// What was moved out of the way and could not be removed at once (a program had it mapped) is removed later: tried
// again with every file that is replaced, added to, moved or deleted after it, for as long as this runtime runs.
const leftAside = new Set();
const retryAside = () => { for (const earlier of [...leftAside]) { try { fs.rmSync(earlier, { force: true }); leftAside.delete(earlier); } catch { /* still held */ } } };
function removeAside(file) {
  try { fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 20 }); } catch { if (leftAside.size < 1000) leftAside.add(file); }
}
// rel: the name the refusal is said with. gone: the name of the file that is missing where one was moved out of the
// way and could not be put back (of two files of a move, the one that was to be replaced).
function unheld(quick, rel, full, work, gone = rel) {
  retryAside();
  try { return work(); }
  catch (failure) {
    if (failure?.displaced) throw displaced(gone, failure.displaced);
    throw quick && WINDOWS && HELD.includes(failure?.code) && writableFile(full) ? busy(rel) : failure;
  }
}
export const __test = { leftAside, unheld };
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
// A project protects credential-like files unless its owner turned that off.
const protects = project => project.protectSecrets !== false;
const hidden = (project, rel) => protects(project) && isSensitiveWorkspacePath(rel);

// Marks the view of a project that stands in a working copy this runtime made (see inCopy). Not a name data can carry.
const OWN_COPY = Symbol('own copy');
// What goes with a project that is taken off the list (the store removes every record of the project with it, and
// project.remove the copies): said wherever taking it off is the remedy, so that it is not taken for a small step.
export const KEPT_FOR_A_PROJECT = 'everything DevMate keeps for it: its workflows, tasks, agents and their messages, approvals and questions, jobs with their output, references and artifacts, and the copies agents worked in that were not applied';
function projectRoot(project) {
  if (!project || typeof project.id !== 'string' || !path.isAbsolute(project.root || '') || !['read', 'write'].includes(project.access)) {
    throw error('invalid_project', 'A project with an absolute root and read/write access is required.');
  }
  // The rule is for a folder an owner shares. A copy of the runtime's own is where the runtime put it, beside its
  // instance directory, and that is ~/.devmate where nothing else was chosen: a name the rule refuses.
  if (!project[OWN_COPY]) assertSafeWorkspaceRoot(project.root);
  let stat;
  try { stat = fs.lstatSync(project.root); }
  catch (failure) {
    // A folder that was shared and has been moved, renamed or deleted since, or whose drive is not there now. The two
    // call for opposite things: a drive is connected again and nothing is lost, while taking the project off the
    // list also takes what is kept for it. So what to do is said for each, and removing is not offered for the first.
    if (project[OWN_COPY] || !['ENOENT', 'ENOTDIR'].includes(failure.code)) throw failure;
    const drive = path.parse(project.root).root;
    // (Asked of a drive letter only: a share that does not answer has just been waited for once already.)
    const away = WINDOWS && /^[A-Za-z]:[\\/]$/.test(drive) && !fs.existsSync(drive);
    throw error('project_missing', away
      ? 'The folder of this project is on a drive that is not connected: ' + project.root + '. Connect the drive and call again; nothing has to be removed for that.'
      : 'The folder of this project is not there: ' + project.root + '. If it is on a disk or a share that is not connected right now, connect it and call again; nothing has to be removed for that. ' +
        'If it was moved, renamed or deleted, its owner takes the project off the list (devmate project remove ' + project.id + ', which also removes ' + KEPT_FOR_A_PROJECT + ') ' +
        'and shares the folder where it is now (devmate project add <folder>).', { projectId: project.id, ...(away ? { driveMissing: true } : {}) });
  }
  // A registered directory that has since been swapped for a link would silently redirect every file tool.
  if (stat.isSymbolicLink()) throw error('unsafe_root', 'The project directory was replaced by a link. Register the real directory again.');
  const root = fs.realpathSync.native(project.root);
  if (!fs.statSync(root).isDirectory()) throw error('invalid_project', 'Project root must be a directory.');
  return root;
}

function relativeInput(value = '.') {
  if (typeof value !== 'string' || !value || /[\0-\x1f]/.test(value) || path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw error('invalid_path', 'Path must be project-relative text.');
  }
  const parts = value.replace(/\\/g, '/').split('/');
  // Device names, alternate data streams and trailing dots or spaces are aliases only on Windows.
  if (WINDOWS && parts.some(p => p.includes(':') || (p !== '.' && p !== '..' && (/[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(?:\.|$)/i.test(p))))) {
    throw error('invalid_path', 'Path contains a Windows device name or filesystem alias.');
  }
  const normalized = path.posix.normalize(parts.join('/'));
  if (normalized === '..' || normalized.startsWith('../')) throw error('outside_project', 'Path escapes the project.');
  return normalized;
}

// Reject links at every component and judge the canonical path as a whole, so
// an allowed file under an otherwise protected directory stays reachable.
// Like Node's ordinary filesystem APIs this is not an OS sandbox against a
// hostile process replacing directory entries concurrently.
// `verified` lets one listing check the project's root and each folder once instead of once per file in it: a find
// over two thousand files would otherwise ask the file system the same questions about the same few folders
// thousands of times. It is a Map that lives for a single call, of one project, with one answer to `links`.
// links: reading may go through a link or junction whose target is still inside the project (a package manager's
// node_modules is made of them). The canonical target is what is judged, so a link is never a way out of the project
// or around the credential protection. Everything that changes a file leaves links alone, as before.
export function resolveProjectPath(project, value = '.', { mustExist = true, policy = true, verified = null, links = false } = {}) {
  let root = verified?.get('\0root');
  if (root === undefined) { root = projectRoot(project); verified?.set('\0root', root); }
  const rel = relativeInput(value);
  let controlRoot = verified?.get('\0control');
  if (controlRoot === undefined) { controlRoot = project.controlRoot ? fs.realpathSync.native(project.controlRoot) : null; verified?.set('\0control', controlRoot); }
  const excludeControl = target => {
    if (controlRoot && inside(controlRoot, target)) throw error('protected_instance_path', 'Instance control storage is not project content.');
  };
  let current = root;
  excludeControl(current);
  excludeControl(path.resolve(root, rel));
  const parts = rel.split('/').filter(p => p && p !== '.');
  let reached = '';
  for (const [index, part] of parts.entries()) {
    reached = reached ? reached + '/' + part : part;
    const known = verified?.get(reached);
    if (known) { current = known; continue; }
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current, { throwIfNoEntry: false }); }
    catch (failure) {
      // POSIX reports a file in the place of a folder this way; Windows simply finds nothing there.
      if (failure.code === 'ENOTDIR') throw error('not_directory', 'Part of this path is a file, not a folder: ' + rel);
      throw failure;
    }
    if (!stat) {
      if (mustExist) throw error('not_found', 'Project path does not exist: ' + rel);
      continue;
    }
    if (stat.isSymbolicLink() && !links) throw error('unsafe_path', 'Symbolic links and directory junctions are not changed through: ' + rel);
    let canonical;
    try { canonical = fs.realpathSync.native(current); }
    catch (failure) { if (failure.code === 'ENOENT') throw error('not_found', 'This link points at nothing: ' + rel); throw failure; }
    if (!inside(root, canonical)) throw error('outside_project', 'Canonical path escapes the project.');
    excludeControl(canonical);
    current = canonical;
    if (verified && index < parts.length - 1 && stat.isDirectory()) verified.set(reached, canonical);
  }
  if (!inside(root, current)) throw error('outside_project', 'Path escapes the project.');
  // policy:false is for the directories leading to an already approved file.
  if (policy && protects(project)) {
    try { assertSafeWorkspacePath(slash(path.relative(root, current)) || '.'); }
    catch (failure) {
      failure.message += ' This project keeps credential-like files and folders out of the file tools. Its owner lifts that for the project on their own computer: in the local workbench (devmate ui), or with devmate project.update. Until then work without this path.';
      throw failure;
    }
  }
  return current;
}

// Open, then verify what was opened: the bytes read are the bytes that were checked.
// linked: a file with several names (a hard link, as package managers make them) may be read, never changed.
function readRegular(full, { limit = MAX_FILE_BYTES, linked = false } = {}) {
  const fd = fs.openSync(full, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.nlink > 1 && !linked)) throw error('unsafe_file', 'Only regular, unlinked files are supported.');
    if (stat.size > limit) throw error('file_too_large', 'This file is ' + Math.round(stat.size / 1048576) + ' MiB, more than the ' + Math.round(limit / 1048576) +
      ' MiB that can be handled here. Look at a part of it with a command (for example its last lines), or page its bytes with operations_query workspace.read_bytes.');
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return bytes.subarray(0, offset);
  } finally { fs.closeSync(fd); }
}
function readBytes(full, options) {
  const stat = fs.lstatSync(full);
  if (stat.isDirectory()) throw error('is_directory', 'This path is a directory, not a file. List it with workspace_files.');
  if (stat.isSymbolicLink()) throw error('unsafe_file', 'Only regular, unlinked files are supported.');
  return readRegular(full, options);
}
/** A project file exactly as the file tools would give it: path policy applied, no link of any kind. */
export function readProjectFile(project, value, { limit } = {}) {
  const full = resolveProjectPath(project, value);
  if (fs.lstatSync(full).isSymbolicLink()) throw error('unsafe_file', 'Only regular, unlinked files are supported.');
  return readRegular(full, limit ? { limit } : undefined);
}
/** Its size, after the same checks, without reading it. */
export function statProjectFile(project, value) {
  const full = resolveProjectPath(project, value), stat = fs.lstatSync(full);
  if (!stat.isFile() || stat.nlink > 1) throw error('unsafe_file', 'Only regular, unlinked files are supported.');
  return { full, stat };
}
function textBytes(bytes) {
  if (bytes.includes(0)) throw error('binary_file', 'This is a binary file, not text. Its bytes can be paged with operations_query workspace.read_bytes.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw error('binary_file', 'This file is text in an encoding other than UTF-8. It can be read with workspace_read; changing it here would rewrite it as UTF-8, so change it with a command (shell_run) or convert it first.'); }
}
// Text that is not UTF-8 is still text. It is decoded so that it can be read: UTF-16 by its byte-order mark,
// anything else as the encoding this computer itself uses for such files, and as Latin-1 when that does not fit.
let localEncoding;
function systemEncoding() {
  if (localEncoding !== undefined) return localEncoding;
  const byCodePage = { 936: 'gbk', 950: 'big5', 932: 'shift_jis', 949: 'euc-kr', 874: 'windows-874' };
  let label = null;
  if (WINDOWS) {
    try {
      const answer = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
        { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const page = Number(answer.match(/ACP\s+REG_SZ\s+(\d+)/)?.[1]);
      label = byCodePage[page] || (page >= 1250 && page <= 1258 ? 'windows-' + page : null);
    } catch {}
  } else {
    const language = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
    label = /^zh-(tw|hk|mo)/.test(language) ? 'big5' : language.startsWith('zh') ? 'gb18030' : language.startsWith('ja') ? 'shift_jis' : language.startsWith('ko') ? 'euc-kr' : null;
  }
  return localEncoding = label || 'windows-1252';
}
export function decodeOtherText(bytes, local = systemEncoding()) {
  for (const [mark, label] of [[[0xFF, 0xFE], 'utf-16le'], [[0xFE, 0xFF], 'utf-16be']]) {
    if (bytes.length >= 2 && bytes[0] === mark[0] && bytes[1] === mark[1]) return { text: new TextDecoder(label).decode(bytes.subarray(2)), encoding: label };
  }
  if (bytes.includes(0)) return null;
  try { return { text: new TextDecoder(local, { fatal: true }).decode(bytes), encoding: local }; } catch {}
  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
}
function gitRevision(value, name = 'ref') {
  if (typeof value !== 'string' || !value || value.startsWith('-') || /[\0\s]/.test(value) || value.length > 250) throw error('invalid_input', name + ' must be a Git revision without spaces or a leading dash.');
  return value;
}
function toolEnvironment() {
  const keep = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'lang', 'lc_all', 'home', 'userprofile',
    'homedrive', 'homepath', 'appdata', 'localappdata', 'programdata', 'xdg_config_home', 'nodefaultcurrentdirectoryinexepath']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => keep.has(key.toLowerCase())));
}
function checkedCommand(result, accepted = [0]) {
  if (result.error || result.timedOut || result.exitConfirmed === false || !accepted.includes(result.exitCode)) {
    throw error('command_failed', 'The workspace command did not finish successfully.' + (result.stderr ? ' ' + result.stderr.trim().split(/\r?\n/)[0].slice(0, 300) : ''), {
      exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr
    });
  }
  return result;
}
function emptyCommand() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false, exitConfirmed: true, stdoutTruncated: false, stderrTruncated: false }; }

// scanChars: how much a find or a search takes from ripgrep before it ends it (see scanned).
export function createWorkspaceService({ store, scanChars = 2000000 } = {}) {
  // True while a change is made for a caller that tries again by itself (see unheld above). The changes are made in
  // one go, without a pause in which another could begin, so one flag is enough.
  let quick = false;
  function quickly(change) { const before = quick; quick = true; try { return change(); } finally { quick = before; } }
  // Bookkeeping must never turn a change that already happened into a reported failure.
  const event = (project, type, data) => {
    try { store?.event(type, { id: project.id, projectId: project.id }, data); return null; }
    catch (failure) { return 'The change was made, but recording it in history failed: ' + failure.message; }
  };
  const invoke = (file, args, cwd, input = {}, environment = toolEnvironment()) => executeCommand(resolveTool(file), args, {
    cwd, shell: false, environment, signal: input.signal || null, enough: input.enough === true,
    timeoutMs: bounded(input.timeoutMs, 30000, 300000), maxOutputChars: bounded(input.maxOutputChars, 120000, 2000000)
  });
  // Read-only Git that cannot run anything the repository itself configures:
  // no hooks, fsmonitor, pager, signature program, external diff, and attributes
  // read from the empty tree so no filter or textconv driver applies. The
  // owner's own system and global configuration (autocrlf, excludes, safe.directory) stays in effect.
  const git = (project, args, input, extra) => invoke('git', [
    '--no-pager', '--attr-source=' + EMPTY_TREE, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + gitNull,
    '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args
  ], projectRoot(project), input, { ...toolEnvironment(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1', ...extra });
  // Only a commit may be named: `HEAD:.env` style object paths would bypass the path policy.
  async function commitOf(project, ref, input) {
    const result = await git(project, ['rev-parse', '--verify', '--quiet', '--end-of-options', gitRevision(ref) + '^{commit}'], input);
    const sha = result.stdout.trim();
    if (result.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(sha)) throw error('invalid_input', 'Not a commit in this repository: ' + ref);
    return sha;
  }
  const listable = (project, rel, options) => {
    try { resolveProjectPath(project, rel, options); return true; }
    catch (failure) { if (unlistable.has(failure.code)) return false; throw failure; }
  };

  function files(project, input = {}) {
    const full = resolveProjectPath(project, input.path || '.', { links: true });
    if (!fs.statSync(full).isDirectory()) throw error('not_directory', 'Listing requires a directory.');
    const rel = relativeInput(input.path || '.');
    const scope = hash(project.id + '\0' + full);
    let after = '';
    if (input.cursor) {
      try { const c = JSON.parse(Buffer.from(input.cursor, 'base64url').toString()); if (c.scope !== scope || typeof c.after !== 'string') throw 0; after = c.after; }
      catch { throw error('invalid_cursor', 'Cursor does not belong to this directory.'); }
    }
    const entries = fs.readdirSync(full, { withFileTypes: true });
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw error('scan_limit', 'Directory has too many entries; use workspace_find with a pattern.');
    const limit = bounded(input.limit, 200, 1000);
    const items = [], verified = new Map();
    let withheld = 0;
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name <= after || entry.name.startsWith('.devmate-write-') || entry.name === '.git') continue;
      const childRel = path.posix.join(rel, entry.name);
      // What cannot be read is not listed either, but it is counted: an entry that silently is not there sends a model looking for it.
      if (hidden(project, childRel) || !listable(project, childRel, { links: true, verified })) { withheld++; continue; }
      const stat = fs.statSync(path.join(full, entry.name), { throwIfNoEntry: false });
      if (!stat || (!stat.isFile() && !stat.isDirectory())) { withheld++; continue; }
      items.push({ name: entry.name, path: slash(childRel), type: stat.isDirectory() ? 'directory' : 'file', size: stat.size });
      if (items.length > limit) break;
    }
    const more = items.length > limit;
    if (more) items.pop();
    return { items, ...(more ? { nextCursor: Buffer.from(JSON.stringify({ scope, after: items.at(-1).name })).toString('base64url') } : {}),
      ...(withheld ? { withheld, note: withheld + ' entr' + (withheld === 1 ? 'y is' : 'ies are') + ' not shown: links that lead out of the project, or paths the project\'s credential-file protection keeps back.' } : {}) };
  }

  // Prior content is kept content-addressed in the private instance directory,
  // so every edit, overwrite, move and delete made through DevMate is reversible.
  function snapshot(project, bytes) {
    if (!project.controlRoot || bytes === null) return null;
    const directory = path.join(project.controlRoot, 'history');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const sha256 = hash(bytes), target = path.join(directory, sha256);
    if (fs.existsSync(target)) {
      // Retention is by last use: a version kept again today must outlive one first kept long ago.
      const now = new Date();
      fs.utimesSync(target, now, now);
      return sha256;
    }
    const pending = target + '.' + randomUUID();
    try { fs.writeFileSync(pending, bytes, { flag: 'wx', mode: 0o600 }); fs.renameSync(pending, target); }
    finally { fs.rmSync(pending, { force: true }); }
    return sha256;
  }
  const snapshotPath = (project, sha256) => project.controlRoot ? path.join(project.controlRoot, 'history', sha256) : null;
  // What a file holds, as its hash: read whole up to the size of an edit, in pieces beyond it, and not at all beyond
  // what history would keep (null: not known).
  function contentHash(full, size) {
    if (size <= MAX_FILE_BYTES) return hash(readBytes(full));
    if (size > DELETE_SNAPSHOT_BYTES) return null;
    const source = fs.openSync(full, 'r');
    try {
      const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
      for (;;) { const read = fs.readSync(source, chunk, 0, chunk.length, null); if (!read) break; digest.update(chunk.subarray(0, read)); }
      return digest.digest('hex');
    } finally { fs.closeSync(source); }
  }
  // The same for a file too large to hold in memory: copied and hashed in one pass.
  function snapshotFile(project, full) {
    if (!project.controlRoot) return null;
    const directory = path.join(project.controlRoot, 'history');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const pending = path.join(directory, 'incoming.' + randomUUID());
    const source = fs.openSync(full, 'r');
    let target = null;
    try {
      const stat = fs.fstatSync(source);
      if (!stat.isFile() || stat.nlink > 1 || stat.size > DELETE_SNAPSHOT_BYTES) return null;
      target = fs.openSync(pending, 'wx', 0o600);
      const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(1024 * 1024);
      for (let offset = 0; ;) {
        const count = fs.readSync(source, chunk, 0, chunk.length, offset);
        if (!count) break;
        digest.update(chunk.subarray(0, count));
        fs.writeSync(target, chunk, 0, count);
        offset += count;
      }
      fs.closeSync(target); target = null;
      const sha256 = digest.digest('hex'), kept = path.join(directory, sha256);
      if (fs.existsSync(kept)) { const now = new Date(); fs.utimesSync(kept, now, now); }
      else fs.renameSync(pending, kept);
      return sha256;
    } finally {
      if (target !== null) fs.closeSync(target);
      fs.closeSync(source);
      fs.rmSync(pending, { force: true });
    }
  }

  function read(project, input = {}, { local = false } = {}) {
    const pageChars = local ? LOCAL_READ_CHAR_LIMIT : READ_CHAR_LIMIT, numberChars = local ? 1 : LINE_NUMBER_CHARS;
    const full = resolveProjectPath(project, input.path, { links: true });
    // Reading is paged, so it takes larger files than editing does: a long log is read a part at a time.
    const bytes = readBytes(full, { limit: READ_FILE_BYTES, linked: true });
    let text, encoding = null;
    try { text = textBytes(bytes); }
    catch (failure) {
      const other = failure.code === 'binary_file' ? decodeOtherText(bytes) : null;
      if (!other) throw failure;
      ({ text, encoding } = other);
    }
    const foreign = encoding ? 'This file is ' + encoding + ' text, not UTF-8; it is shown decoded. Changing it with workspace_edit or workspace_write would rewrite it as UTF-8 and is refused: change it with a command.' : null;
    const sha256 = hash(bytes), rel = relativeInput(input.path);
    const lines = text.split('\n');
    // A final newline ends the last line; it does not start another one.
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    const totalLines = lines.length;
    if (input.startLine === undefined && input.lineCount === undefined && text.length + (local ? 0 : totalLines * numberChars) <= pageChars) {
      return { path: rel, text, sha256, totalLines, startLine: 1, endLine: totalLines, truncated: false, partial: false, ...(foreign ? { encoding, note: foreign } : {}) };
    }
    if (input.startLine !== undefined && input.startLine > totalLines) throw error('invalid_range', 'startLine exceeds the ' + totalLines + ' lines of this file.');
    const startLine = bounded(input.startLine, 1, totalLines);
    const wanted = bounded(input.lineCount, READ_LINE_LIMIT, 20000);
    const selected = [];
    let size = 0, longLine = null;
    for (let index = startLine - 1; index < totalLines && selected.length < wanted; index++) {
      if (selected.length && size + lines[index].length + numberChars > pageChars) break;
      if (lines[index].length > pageChars) longLine ??= index + 1;
      selected.push(lines[index].length > pageChars ? lines[index].slice(0, pageChars) : lines[index]);
      size += lines[index].length + numberChars;
    }
    const endLine = startLine + selected.length - 1;
    // sha256 always identifies the whole file, so a page can still guard an edit.
    return { path: rel, text: selected.join('\n'), sha256, totalLines, startLine, endLine,
      truncated: longLine !== null || endLine < totalLines, partial: startLine > 1 || endLine < totalLines, ...(endLine < totalLines ? { nextStartLine: endLine + 1 } : {}),
      ...(foreign ? { encoding } : {}),
      ...(longLine !== null || foreign ? { ...(longLine !== null ? { cutLine: longLine } : {}), note: [foreign, longLine !== null ? 'Line ' + longLine + ' is longer than ' + pageChars + ' characters and was cut; its bytes can be paged with operations_query workspace.read_bytes.' : null].filter(Boolean).join(' ') } : {}) };
  }

  function readBytePage(project, input = {}) {
    const full = resolveProjectPath(project, input.path, { links: true });
    const before = fs.lstatSync(full, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      throw error('unsafe_file', 'Only regular project files are readable.');
    const offset = input.offset ?? 0;
    const length = input.length ?? 65536;
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 1 || length > 96 * 1024)
      throw error('invalid_range', 'Use a nonnegative safe offset and a page of at most 96 KiB.');
    const fd = fs.openSync(full, 'r');
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() ||
        stat.dev !== before.dev || stat.ino !== before.ino)
        throw error('unsafe_file', 'File changed while opening it.');
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw error('file_too_large', 'File byte offsets exceed safe integer precision.');
      const totalBytes = Number(stat.size);
      if (offset > totalBytes) throw error('invalid_range', 'Offset exceeds the end of this file.');
      const version = hash([stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':'));
      if (input.expectedVersion !== undefined && input.expectedVersion !== version)
        throw error('conflict', 'File changed between byte pages.');
      const bytes = Buffer.allocUnsafe(Math.min(length,totalBytes-offset));
      const n = bytes.length ? fs.readSync(fd,bytes,0,bytes.length,offset) : 0;
      if (n !== bytes.length) throw error('conflict', 'File changed while reading this page.');
      const nextOffset = offset+n < totalBytes ? offset+n : null;
      return {path:relativeInput(input.path),offset,bytes:n,totalBytes,version,
        encoding:'base64',base64:bytes.subarray(0,n).toString('base64'),nextOffset};
    } finally { fs.closeSync(fd); }
  }

  function writable(project) {
    if (project.access !== 'write') throw error('read_only', 'This project is read-only.');
  }
  function write(project, input = {}) {
    writable(project);
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_FILE_BYTES || input.text.includes('\0')) throw error('invalid_input', 'A UTF-8 text value up to 8 MiB is required.');
    const expected = input.expectedSha256 ?? null;
    if (expected !== null && (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected))) throw error('invalid_input', 'expectedSha256 is the sha256 returned by workspace_read.');
    // append: the text goes to the end of what is there, which is kept like before any change. A file that is not
    // there is created. It says nothing about what the file holds, so it takes no expectedSha256 and no overwrite.
    if (input.append) {
      if (expected !== null || input.overwrite) throw error('invalid_input', 'append adds to what the file holds: it takes neither expectedSha256 nor overwrite.');
      const rel = relativeInput(input.path), full = resolveProjectPath(project, rel, { mustExist: false });
      // (A file with a second name is refused here as by every write: its bytes are shared with a path that may lie
      // outside the project.)
      const current = fs.existsSync(full) ? readBytes(full) : null;
      if (current?.includes(0)) throw error('invalid_input', 'append is for text files; this one holds binary data.');
      // What is added is UTF-8. A file in another encoding would hold two after it, which nothing reads: refused in
      // the words workspace_edit refuses it with.
      if (current) textBytes(current);
      const added = Buffer.from(input.text);
      if ((current?.length || 0) + added.length > MAX_FILE_BYTES) throw error('invalid_input', 'The file would grow beyond 8 MiB.');
      // A file that is not there is made as every new file is.
      if (!current) return publish(project, rel, added, null);
      if (!added.length) return { path: rel, sha256: hash(current), written: false };
      if (!writableFile(full)) throw readOnlyFile(rel);
      const previousSha256 = snapshot(project, current);
      // The text goes to the end of the file itself, where it is. A program that has the file open to write to it (a
      // server and its log) goes on writing to the same file; replaced, as every other write replaces a file, that
      // program would be left writing to the one that was moved away, and nothing it wrote would be seen again.
      unheld(quick, rel, full, () => fs.appendFileSync(full, added));
      // What the file holds now, which is more than was added here when that program wrote meanwhile. From here on
      // the text is in the file: where it cannot be read back (that program has pushed it past what is read, or holds
      // it this moment) the call still says "written", without a hash, and never fails after the fact, which would
      // have the text added a second time.
      let sha256 = null;
      try { sha256 = hash(readBytes(full)); } catch { /* said below */ }
      const result = { path: rel, ...(sha256 ? { sha256 } : {}), written: true };
      const warning = event(project, 'workspace.file.written', { ...result, sha256, previousSha256 });
      const note = sha256 ? null : 'The text was added. What the file holds now could not be read back (another program may be writing to it, or has it open, or has moved or replaced it since): no sha256 is given. Read the file again before changing it.';
      return { ...result, ...(note ? { note } : {}), ...(warning ? { warning } : {}) };
    }
    // overwrite: the caller means to replace whatever is there. What is there is still kept, like before any change.
    if (input.overwrite && expected === null) {
      const full = resolveProjectPath(project, input.path, { mustExist: false });
      return publish(project, input.path, Buffer.from(input.text), fs.existsSync(full) ? hash(readBytes(full)) : null);
    }
    return publish(project, input.path, Buffer.from(input.text), expected?.toLowerCase() ?? null);
  }

  // The one place file content is replaced: compare-and-swap, snapshot, atomic publish.
  function publish(project, target, bytes, expectedSha256) {
    const rel = relativeInput(target);
    const full = resolveProjectPath(project, rel, { mustExist: false });
    if (full === projectRoot(project)) throw error('invalid_path', 'Cannot write the project root.');
    const parentRel = slash(path.dirname(rel));
    try { fs.mkdirSync(resolveProjectPath(project, parentRel, { mustExist: false, policy: false }), { recursive: true }); }
    catch (failure) { if (['EEXIST', 'ENOTDIR'].includes(failure.code)) throw error('not_directory', 'Part of this path is a file, not a folder: ' + parentRel); throw failure; }
    const parent = resolveProjectPath(project, parentRel, { policy: false });
    if (!fs.statSync(parent).isDirectory()) throw error('not_directory', 'The parent path is a file, not a directory: ' + parentRel);
    const current = fs.existsSync(full) ? readBytes(full) : null;
    const currentSha256 = current === null ? null : hash(current);
    if (currentSha256 !== expectedSha256) {
      throw error('conflict', expectedSha256 === null
        ? 'This file already exists. To replace it pass its sha256 from workspace_read as expectedSha256, or change part of it with workspace_edit.'
        : 'The file changed since it was read; read it again before writing.');
    }
    if (current?.equals(bytes)) return { path: rel, sha256: currentSha256, written: false };
    keptReadOnly(rel, full);
    snapshot(project, current);
    const temp = path.join(parent, '.devmate-write-' + randomUUID());
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', current === null ? 0o666 : fs.statSync(full).mode & 0o777);
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
      // Synchronous check+publish cannot interleave another service write in this host.
      // External editors do not participate in this CAS; their changes are checked again here.
      resolveProjectPath(project, rel, { mustExist: false });
      const latest = fs.existsSync(full) ? readBytes(full) : null;
      if ((latest === null ? null : hash(latest)) !== currentSha256) throw error('conflict', 'File changed before publication.');
      // A file that is in the way and open in another program is moved aside under a working copy's name (never
      // listed), see replaceFile.
      if (current !== null) unheld(quick, rel, full, () => replaceFile(temp, full, { aside: path.join(parent, '.devmate-write-' + randomUUID()), remove: removeAside, ...(quick ? { repeats: QUICK_REPEATS } : {}) }));
      else {
        // Create must never replace a file that appeared meanwhile. A second name for the working copy does that at
        // once and whole. Not on Windows: the new file would be the very file a scanner has opened as the working
        // copy, and Windows replaces no file that anyone has open. Measured on a busy computer, 19 of 2400 files
        // made that way could not be replaced a moment later, for a minute and more; of 2400 made as files of their
        // own, none. So there, and on filesystems without second names (exFAT, some network shares), it is an
        // exclusive copy.
        const copied = () => {
          try { fs.copyFileSync(temp, full, fs.constants.COPYFILE_EXCL); }
          catch (failure) { throw failure.code === 'EEXIST' ? error('conflict', 'File changed before publication.') : failure; }
          // The working copy was written through to the disk; its copy is too, where the system lets it be.
          try { const made = fs.openSync(full, 'r+'); try { fs.fsyncSync(made); } finally { fs.closeSync(made); } } catch { /* written, and flushed by the system in its own time */ }
        };
        if (WINDOWS) copied();
        else try { fs.linkSync(temp, full); }
        catch (failure) {
          if (failure.code === 'EEXIST') throw error('conflict', 'File changed before publication.');
          copied();
        }
      }
    } finally {
      if (fd != null) fs.closeSync(fd);
      // The write itself is decided above. Removing the working copy is repeated while a scanner holds it, and never
      // turns a finished write into a failure.
      try { fs.rmSync(temp, { force: true, maxRetries: 5, retryDelay: 20 }); } catch {}
    }
    const result = { path: rel, sha256: hash(bytes), written: true };
    const warning = event(project, 'workspace.file.written', { ...result, previousSha256: currentSha256 });
    return warning ? { ...result, warning } : result;
  }

  function edit(project, input = {}) {
    writable(project);
    if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 200) throw error('invalid_input', 'Supply 1 to 200 edits.');
    const full = resolveProjectPath(project, input.path);
    const before = readBytes(full), sha256 = hash(before);
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) throw error('conflict', 'File changed; read it again before editing.');
    // The decoder drops a leading byte-order mark; the file keeps the one it had.
    const marked = before.subarray(0, 3).equals(BOM);
    let text = textBytes(before), replacements = 0;
    // A file that ends every line with CRLF keeps doing so, whatever line breaks the replacement text was sent with.
    const crlf = text.includes('\r\n'), uniform = crlf && !/(?<!\r)\n/.test(text);
    const occurrences = needle => text.split(needle).length - 1;
    input.edits.forEach((item, index) => {
      if (!item || typeof item.oldText !== 'string' || typeof item.newText !== 'string' || !item.oldText || item.oldText === item.newText) {
        throw error('invalid_input', 'Edit ' + (index + 1) + ' needs a nonempty oldText that differs from newText.');
      }
      // Exact text first. Text copied from a read uses \n; if the file uses \r\n there, match that instead.
      let oldText = item.oldText, newText = uniform ? item.newText.replace(/\r?\n/g, '\r\n') : item.newText, count = occurrences(oldText);
      if (!count && crlf) {
        const converted = item.oldText.replace(/\r?\n/g, '\r\n');
        if (converted !== item.oldText && occurrences(converted)) {
          oldText = converted; newText = item.newText.replace(/\r?\n/g, '\r\n'); count = occurrences(oldText);
        }
      }
      if (!count) throw error('edit_not_found', 'Edit ' + (index + 1) + ': oldText does not occur in the file. Read the file again and copy the exact text, without line-number prefixes.', { edit: index + 1 });
      if (count > 1 && !item.replaceAll) throw error('edit_ambiguous', 'Edit ' + (index + 1) + ': oldText occurs ' + count + ' times. Add surrounding lines to make it unique, or set replaceAll.', { edit: index + 1, occurrences: count });
      text = item.replaceAll ? text.split(oldText).join(newText) : text.replace(oldText, () => newText);
      replacements += item.replaceAll ? count : 1;
    });
    const after = marked ? Buffer.concat([BOM, Buffer.from(text)]) : Buffer.from(text);
    if (text.includes('\0') || after.length > MAX_FILE_BYTES) throw error('invalid_input', 'The edited file must remain UTF-8 text up to 8 MiB.');
    return { ...publish(project, input.path, after, sha256), previousSha256: sha256, replacements };
  }

  // Several files changed as one. Every change is worked out first, against what is on disk, and nothing is written
  // unless all of them fit. Each file is then changed like any other change (the previous version kept, the change
  // recorded); should one fail on the way, the ones already made are taken back.
  function applyPatch(project, input = {}) {
    writable(project);
    const named = new Set();
    const claim = rel => {
      const key = CASE_INSENSITIVE ? rel.toLowerCase() : rel;
      if (named.has(key)) throw error('invalid_patch', 'The patch names ' + rel + ' more than once. Put everything that changes one file into one section.');
      named.add(key);
      return rel;
    };
    const plan = parsePatch(input.patch).map(change => {
      const rel = claim(relativeInput(change.path));
      if (change.action === 'add') {
        if (fs.existsSync(resolveProjectPath(project, rel, { mustExist: false }))) throw error('already_exists', rel + ' already exists. Change it with an update section, or delete it in the same patch under another name first.');
        const bytes = Buffer.from(change.text);
        if (change.text.includes('\0') || bytes.length > MAX_FILE_BYTES) throw error('invalid_input', rel + ' must be UTF-8 text up to 8 MiB.');
        return { operation: 'add', path: rel, bytes, expected: null, additions: change.text ? change.text.split('\n').length - (change.text.endsWith('\n') ? 1 : 0) : 0, removals: 0 };
      }
      const before = readBytes(resolveProjectPath(project, rel)), sha256 = hash(before);
      if (change.action === 'delete' && !change.hunks.length) return { operation: 'delete', path: rel, expected: sha256 };
      const result = patchText(textBytes(before), change);
      if (change.action === 'delete') {
        if (result.text) throw error('patch_failed', 'The patch deletes ' + rel + ', but its hunks leave part of the file. Read the file again. Nothing was changed.', { path: rel });
        return { operation: 'delete', path: rel, expected: sha256, additions: 0, removals: result.removals };
      }
      // The decoder drops a leading byte-order mark; the file keeps the one it had.
      const bytes = before.subarray(0, 3).equals(BOM) ? Buffer.concat([BOM, Buffer.from(result.text)]) : Buffer.from(result.text);
      if (result.text.includes('\0') || bytes.length > MAX_FILE_BYTES) throw error('invalid_input', rel + ' must remain UTF-8 text up to 8 MiB.');
      const step = { path: rel, bytes, expected: sha256, additions: result.additions, removals: result.removals, ...(result.lines.length ? { lines: result.lines } : {}) };
      if (!change.moveTo) return { operation: 'update', ...step };
      const to = claim(relativeInput(change.moveTo));
      if (fs.existsSync(resolveProjectPath(project, to, { mustExist: false }))) throw error('already_exists', 'The patch moves ' + rel + ' to ' + to + ', where something already is.');
      return { operation: 'move', ...step, path: to, previousPath: rel };
    });
    const shown = plan.map(({ bytes, expected, ...step }) => step);
    const totals = { additions: plan.reduce((sum, step) => sum + (step.additions || 0), 0), removals: plan.reduce((sum, step) => sum + (step.removals || 0), 0) };
    if (input.dryRun) return { dryRun: true, files: shown, ...totals };
    const since = store?.revision ?? null;
    let started = 0, warning = null;
    try {
      // What a patch deletes goes last: a failure before that has lost nothing yet.
      for (const step of [...plan.filter(item => item.operation !== 'delete'), ...plan.filter(item => item.operation === 'delete')]) {
        started++;
        if (step.operation === 'delete') {
          if (hash(readBytes(resolveProjectPath(project, step.path))) !== step.expected) throw error('conflict', step.path + ' changed while the patch was being applied.');
          warning ||= remove(project, { path: step.path }).warning;
        } else {
          if (step.operation === 'move') warning ||= move(project, { from: step.previousPath, to: step.path }).warning;
          warning ||= publish(project, step.path, step.bytes, step.expected).warning;
        }
      }
    } catch (failure) {
      // What was already written is undone the way a person would undo it: from the history, newest first.
      const left = since === null ? (started > 1 ? ['what was written before the failure (no history is kept here)'] : [])
        : takeBack(project, { since }).left.map(item => item.path + ' (' + item.reason + ')');
      failure.message = 'The patch was not applied: ' + failure.message +
        (left.length ? ' These changes of it could not be taken back and are still there: ' + left.join('; ') + '.' : ' Nothing of it was kept.');
      // With something of it still there the same patch no longer fits: it is not to be tried again as it is.
      if (left.length) failure.incomplete = true;
      throw failure;
    }
    return { files: shown, ...totals, ...(since !== null ? { since } : {}), ...(warning ? { warning } : {}) };
  }

  function mkdir(project, input = {}) {
    writable(project);
    const rel = relativeInput(input.path);
    const full = resolveProjectPath(project, rel, { mustExist: false });
    const existing = fs.statSync(full, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) throw error('not_directory', 'A file already exists at this path.');
    fs.mkdirSync(full, { recursive: true });
    return { path: rel, created: !existing };
  }

  // Every regular file below a directory, links never followed. With protection
  // on, a credential-like entry anywhere inside stops the whole operation.
  function directoryFiles(project, rel, full, action) {
    const found = [];
    const descend = (directoryRel, directoryFull) => {
      for (const entry of fs.readdirSync(directoryFull, { withFileTypes: true })) {
        const childRel = path.posix.join(directoryRel, entry.name), childFull = path.join(directoryFull, entry.name);
        if (hidden(project, childRel)) throw error('protected_content', 'This directory contains protected files (' + childRel + '), so it cannot be ' + action + ' as a whole. Handle the other entries individually.');
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) descend(childRel, childFull);
        else if (entry.isFile()) found.push({ rel: slash(childRel), full: childFull });
        if (found.length > MAX_DIRECTORY_ENTRIES) throw error('scan_limit', 'The directory holds more than ' + MAX_DIRECTORY_ENTRIES + ' files, too many to check here. Use shell_run for it.');
      }
    };
    descend(rel, full);
    return found;
  }

  function move(project, input = {}) {
    writable(project);
    const from = relativeInput(input.from), to = relativeInput(input.to);
    const source = resolveProjectPath(project, from);
    if (source === projectRoot(project)) throw error('invalid_path', 'Cannot move the project root.');
    const target = resolveProjectPath(project, to, { mustExist: false });
    // On a case-insensitive filesystem a case-only rename resolves to the same entry.
    const caseOnly = source === target && path.posix.basename(from) !== path.posix.basename(to);
    if (source === target && !caseOnly) throw error('invalid_input', 'Source and destination are the same path.');
    // Checked before anything is created: preparing the destination would otherwise make folders inside the source.
    if (source !== target && inside(source, target)) throw error('invalid_input', 'A folder cannot be moved into itself.');
    const parentRel = slash(path.dirname(to));
    try { fs.mkdirSync(resolveProjectPath(project, parentRel, { mustExist: false, policy: false }), { recursive: true }); }
    catch (failure) { if (['EEXIST', 'ENOTDIR'].includes(failure.code)) throw error('not_directory', 'Part of this path is a file, not a folder: ' + parentRel); throw failure; }
    const parent = resolveProjectPath(project, parentRel, { policy: false });
    if (!fs.statSync(parent).isDirectory()) throw error('not_directory', 'The destination parent is a file, not a directory.');
    const sourceStat = fs.lstatSync(source), targetStat = caseOnly ? null : fs.lstatSync(target, { throwIfNoEntry: false });
    if (sourceStat.isDirectory() && protects(project)) directoryFiles(project, from, source, 'moved');
    let replacedSha256 = null;
    if (targetStat) {
      if (!input.overwrite || !sourceStat.isFile() || !targetStat.isFile()) throw error('already_exists', 'Destination exists. Only a file can replace a file, with overwrite:true.');
      keptReadOnly(to, target);
      replacedSha256 = snapshot(project, readBytes(target));
    }
    // With a file in the way either of the two may be the one a program holds: the refusal names both.
    unheld(quick, targetStat ? from + ' or ' + to : from, source, () => replaceFile(source, caseOnly ? path.join(path.dirname(source), path.posix.basename(to)) : target,
      { repeats: quick ? QUICK_REPEATS : 0, ...(targetStat ? { aside: path.join(parent, '.devmate-write-' + randomUUID()), remove: removeAside } : {}) }), to);
    const result = { from, to, type: sourceStat.isDirectory() ? 'directory' : 'file' };
    const warning = event(project, 'workspace.file.moved', { from, path: to, entry: result.type, ...(replacedSha256 ? { previousSha256: replacedSha256 } : {}) });
    return warning ? { ...result, warning } : result;
  }

  function remove(project, input = {}) {
    writable(project);
    const rel = relativeInput(input.path);
    const full = resolveProjectPath(project, rel);
    if (full === projectRoot(project)) throw error('invalid_path', 'Cannot delete the project root.');
    const stat = fs.lstatSync(full);
    // A hard-linked file shares its bytes with a path that may lie outside the project; never copy them into history.
    const keep = file => {
      const s = fs.lstatSync(file);
      if (!s.isFile() || s.nlink !== 1) return null;
      return s.size <= MAX_FILE_BYTES ? snapshot(project, readRegular(file)) : snapshotFile(project, file);
    };
    if (!stat.isDirectory()) {
      if (!stat.isFile()) throw error('unsafe_file', 'Only regular files and directories can be deleted.');
      // Nothing is lost quietly: a file too large to keep is deleted only when the caller says so.
      if (stat.nlink === 1 && stat.size > DELETE_SNAPSHOT_BYTES && !input.force) {
        throw error('too_large_to_keep', 'This file is ' + Math.round(stat.size / 1048576) + ' MiB, more than DevMate keeps for undo. Pass force:true to delete it without a restorable copy.');
      }
      keptReadOnly(rel, full);
      const previousSha256 = keep(full);
      unheld(quick, rel, full, () => fs.unlinkSync(full));
      const warning = event(project, 'workspace.file.removed', { path: rel, entry: 'file', previousSha256 });
      return { path: rel, removed: true, type: 'file', restorable: !!previousSha256, ...(previousSha256 ? { previousSha256 } : {}), ...(warning ? { warning } : {}) };
    }
    const contents = directoryFiles(project, rel, full, 'deleted');
    if (contents.length && !input.recursive) throw error('directory_not_empty', 'Set recursive:true to delete this directory and the ' + contents.length + ' file(s) in it.');
    const bytes = contents.reduce((total, item) => total + fs.lstatSync(item.full).size, 0);
    const keepAll = contents.length <= DELETE_SNAPSHOT_FILES && bytes <= DELETE_SNAPSHOT_BYTES;
    if (!keepAll && !input.force) {
      throw error('too_large_to_keep', 'This directory holds ' + contents.length + ' files (' + Math.round(bytes / 1048576) + ' MiB), more than DevMate keeps for undo. Pass force:true to delete it without restorable copies.');
    }
    const kept = keepAll ? contents.map(item => ({ path: item.rel, full: item.full, previousSha256: keep(item.full) })).filter(item => item.previousSha256) : [];
    let failure = null;
    try { fs.rmSync(full, { recursive: true }); } catch (caught) { failure = caught; }
    let warning = null;
    const record = () => {
      // A removal that stopped halfway still records what is already gone, so that it stays restorable.
      for (const item of kept) if (!failure || !fs.existsSync(item.full)) warning ||= event(project, 'workspace.file.removed', { path: item.path, entry: 'file', previousSha256: item.previousSha256, directory: rel });
      if (!failure) warning ||= event(project, 'workspace.file.removed', { path: rel, entry: 'directory', files: contents.length });
    };
    if (store?.transaction) store.transaction(record); else record();
    if (failure) {
      const gone = contents.filter(item => !fs.existsSync(item.full)), back = kept.filter(item => !fs.existsSync(item.full)).length;
      // Nothing of it is gone: where it is Windows not letting go of a file, that is a thing to try again.
      if (!gone.length) throw quick && WINDOWS && HELD.includes(failure.code) ? busy(rel) : failure;
      // Part of it is gone, and is said with its number and with whether it can be brought back: files deleted with
      // force are not kept. It is not made again by itself, so that no later answer counts only what was left by then.
      throw Object.assign(error('delete_incomplete', 'Only part of ' + rel + ' was deleted: ' + gone.length + ' of the ' + contents.length + ' file(s) in it are gone' +
        (back === gone.length ? ' and can be brought back (workspace_history lists them)' : back ? ', ' + back + ' of which can be brought back (workspace_history lists them)' : ', and none of them was kept') +
        '. Then this stopped it: ' + (WINDOWS && HELD.includes(failure.code) ? 'another program has a file in it open' : failure.message) + '. The rest is still there; the same call again deletes it once that is out of the way.',
      { deleted: gone.length, restorable: back, remaining: contents.length - gone.length }), { incomplete: true });
    }
    return { path: rel, removed: true, type: 'directory', files: contents.length, restorableFiles: kept.length,
      restorable: kept.length === contents.length, ...(warning ? { warning } : {}) };
  }

  function history(project, input = {}) {
    const rel = input.path ? relativeInput(input.path) : null;
    if (rel) resolveProjectPath(project, rel, { mustExist: false });
    const available = sha => !!sha && fs.existsSync(snapshotPath(project, sha) || '');
    const items = (store?.fileEvents?.(project.id, HISTORY_EVENTS, { path: rel, caseInsensitive: CASE_INSENSITIVE, limit: bounded(input.limit, 20, 200) }) || [])
      .filter(item => !hidden(project, item.path)).map(item => ({
        sequence: item.sequence, at: item.createdAt, action: item.type.split('.').pop(), path: item.path,
        ...(item.entry === 'directory' ? { directory: true } : {}), ...(item.from ? { from: item.from } : {}),
        ...(item.sha256 ? { sha256: item.sha256 } : {}),
        ...(item.previousSha256 ? { previousSha256: item.previousSha256, previousRestorable: available(item.previousSha256) } : {}) }));
    return { ...(rel ? { path: rel } : {}), items };
  }

  // recorded: the version was just read from this project's own history (takeBack), so the history is not searched
  // for it again. That search reads every entry of the project, once for each file that is taken back.
  function restore(project, input = {}, { recorded = false } = {}) {
    writable(project);
    if (input.since !== undefined) return takeBack(project, input);
    if (input.path === undefined) throw error('invalid_input', 'Give path and sha256 of one version from workspace_history, or since to take back every change after one history entry.');
    if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw error('invalid_input', 'sha256 must identify a version from workspace_history.');
    const stored = snapshotPath(project, input.sha256);
    // The store is shared by content hash; a version is restorable only where this project recorded it.
    if (!stored || !fs.existsSync(stored) || !(recorded || store?.hasFileVersion?.(project.id, HISTORY_EVENTS, input.sha256))) throw error('not_found', 'That version is not kept in this project\'s DevMate history.');
    const bytes = fs.readFileSync(stored);
    if (hash(bytes) !== input.sha256) throw error('history_corrupt', 'Stored history does not match its hash.');
    const rel = relativeInput(input.path);
    const full = resolveProjectPath(project, rel, { mustExist: false });
    if (fs.existsSync(full) && fs.lstatSync(full).size > MAX_FILE_BYTES) throw error('file_too_large', 'A file larger than ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MiB is in the way at this path. Move or delete it first; deleting keeps it restorable too.');
    const current = fs.existsSync(full) ? hash(readBytes(full)) : null;
    return { ...publish(project, rel, bytes, current), restoredFrom: input.sha256 };
  }

  // Every change these tools made after one history entry, taken back newest first. Each step is checked against what
  // is on disk now, after the steps before it: a file that something else changed in the meantime is left alone and
  // listed. What a step replaces is kept like any other change, so taking back can itself be taken back.
  function takeBack(project, input) {
    if (input.path !== undefined || input.sha256 !== undefined) throw error('invalid_input', 'Use either path with sha256 (one version of one file), or since (every change after one history entry).');
    if (!Number.isSafeInteger(input.since) || input.since < 0) throw error('invalid_input', 'since is the number of an entry in workspace_history.');
    const events = store?.fileEventsAfter?.(project.id, HISTORY_EVENTS, input.since, TAKE_BACK_EVENTS + 1) || [];
    if (events.length > TAKE_BACK_EVENTS) throw error('too_many_changes', 'More than ' + TAKE_BACK_EVENTS + ' changes were made after that entry. Choose a later one, or restore the files you need one by one.');
    const restored = [], left = [];
    const leave = reason => Object.assign(new Error(reason), { left: true });
    const at = rel => resolveProjectPath(project, rel, { mustExist: false });
    const present = rel => fs.lstatSync(at(rel), { throwIfNoEntry: false }) || null;
    for (const item of events.reverse()) {
      const step = { entry: item.sequence, path: item.path };
      try {
        if (hidden(project, item.path) || (item.from && hidden(project, item.from))) throw leave('this project protects it');
        if (item.type === 'workspace.file.moved') {
          if (!present(item.path)) throw leave('it is no longer at ' + item.path);
          // A rename that only changed the case of the name is the same entry under both names.
          if (present(item.from) && at(item.from) !== at(item.path)) throw leave('something is at ' + item.from + ' now');
          move(project, { from: item.path, to: item.from });
          if (item.previousSha256) restore(project, { path: item.path, sha256: item.previousSha256 }, { recorded: true });
          restored.push({ ...step, action: 'moved back', to: item.from });
        } else if (item.type === 'workspace.file.removed') {
          // The files of a deleted folder are entries of their own; bringing them back brings the folders back.
          if (item.entry === 'directory') continue;
          if (present(item.path)) throw leave('something is at this path now');
          if (!item.previousSha256) throw leave('no copy was kept when it was deleted');
          restore(project, { path: item.path, sha256: item.previousSha256 }, { recorded: true });
          restored.push({ ...step, action: 'brought back' });
        } else {
          const stat = present(item.path);
          // A file whose content after the change is not known (too large to have been read, or not readable at that
          // moment) cannot be told from one that was changed since: it is left alone, never taken for unchanged. Also
          // where nothing is under its name any more: that it is gone is a change too, and what was there before is
          // not made anew on the ground that nothing matches nothing.
          if (!item.sha256) throw leave('what this change wrote was not recorded (it was too large, or could not be read back), so it cannot be told whether it was changed since');
          if ((stat?.isFile() ? contentHash(at(item.path), stat.size) : null) !== item.sha256) throw leave('it was changed again by something else');
          if (item.previousSha256) { restore(project, { path: item.path, sha256: item.previousSha256 }, { recorded: true }); restored.push({ ...step, action: 'restored' }); }
          else { remove(project, { path: item.path }); restored.push({ ...step, action: 'removed again (this change created it)' }); }
        }
      } catch (failure) { left.push({ ...step, reason: failure.left ? failure.message : (failure.code ? failure.code + ': ' : '') + failure.message }); }
    }
    return { since: input.since, restored, left };
  }

  // ripgrep does the walking and all glob matching: it is fast on very large
  // trees, honours .gitignore and never follows links. DevMate then applies its
  // own path policy to every reported file before anything about it is returned.
  function scanArguments(input) {
    const glob = input.glob;
    if (glob !== undefined && (typeof glob !== 'string' || !glob || glob.length > 500 || /[\0\r\n]/.test(glob))) throw error('invalid_input', 'A glob pattern of up to 500 characters is required.');
    // ripgrep is not asked to sort: sorted, it reads the tree on one thread, several times slower on a large one
    // (measured on eleven thousand files: 6 seconds against 0.7). What it reports is put in order here (inOrder).
    const args = ['--no-config', '--color', 'never', '--hidden', '--no-require-git',
      ...(WINDOWS ? ['--glob-case-insensitive'] : [])];
    if (input.includeIgnored) args.push('--no-ignore');
    if (glob) args.push('--glob', slash(glob).replace(/^\.\//, ''));
    // Later globs win, so exclusions follow the caller's own pattern.
    for (const name of input.includeIgnored ? ['.git'] : skippedDirectories) args.push('--glob', '!' + name);
    return args;
  }
  // By path, folder by folder and name by name, as ripgrep's own sorting gave them: the separator counts as less than
  // any letter, and letters are compared as ripgrep compares them, by their number among all characters. (A string
  // here is compared by its 16-bit units, which puts a character beyond the first 65536, an emoji for one, before
  // some that come earlier: where a name holds such units they are moved to where they belong for the comparison.)
  // What the order is made of is worked out once for each entry.
  // (The units from 0xD800 up: the halves of such a character, and the characters that come after the halves.)
  const HIGH = new RegExp('[' + String.fromCharCode(0xd800) + '-' + String.fromCharCode(0xffff) + ']', 'g');
  const ranked = unit => String.fromCharCode(unit.charCodeAt(0) + (unit.charCodeAt(0) >= 0xe000 ? -0x800 : 0x2000));
  const inOrder = (entries, pathOf) => entries.map(entry => [pathOf(entry).replaceAll('/', '\0').replace(HIGH, ranked), entry])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).map(pair => pair[1]);
  // Null when the file may not be shown; otherwise what one look at it told (its size).
  function visibleFile(project, file, cache) {
    if (!cache.has(file)) {
      let seen = null;
      if (!hidden(project, file) && !path.posix.basename(file).startsWith('.devmate-write-')) {
        try { const stat = fs.statSync(resolveProjectPath(project, file, { verified: cache.folders ||= new Map(), links: true })); if (stat.isFile()) seen = { size: stat.size }; }
        catch (failure) { if (!unlistable.has(failure.code) && failure.code !== 'ENOENT') throw failure; }
      }
      cache.set(file, seen);
    }
    return cache.get(file);
  }
  // What a scan is run with: ripgrep is ended once it has reported more than is ever shown. A search for a common word
  // in a large tree otherwise goes on to write a hundred megabytes that are read and thrown away (measured: over ten
  // seconds for an answer that was complete after a twentieth of one). What is shown then is a part of what matches,
  // not the same part every time, and marked as cut.
  const scanned = input => ({ ...input, maxOutputChars: scanChars, enough: true });
  function scanFailure(result, produced) {
    if (result.endedFull) return;
    // ripgrep exits 1 for "no matches" and 2 when some path could not be read.
    if (result.error || result.timedOut || ![0, 1, 2].includes(result.exitCode) || (result.exitCode === 2 && !produced)) {
      throw error('command_failed', 'The search did not finish successfully.' + (result.stderr ? ' ' + result.stderr.trim().split(/\r?\n/)[0].slice(0, 300) : ''),
        { exitCode: result.exitCode, timedOut: result.timedOut, stderr: result.stderr });
    }
  }

  async function find(project, input = {}) {
    const base = relativeInput(input.path || '.');
    if (!fs.statSync(resolveProjectPath(project, base)).isDirectory()) throw error('not_directory', 'Find requires a directory.');
    const limit = bounded(input.limit, 200, 2000), items = [], cache = new Map();
    let withheld = 0;
    const result = await invoke('rg', ['--files', ...scanArguments({ ...input, glob: input.pattern }), '--', base], projectRoot(project), scanned(input));
    scanFailure(result, !!result.stdout);
    let truncated = result.stdoutTruncated;
    const lines = result.stdout.split(/\r?\n/);
    // Where the list was cut, its last line is a piece of a path.
    if (truncated) lines.pop();
    for (const file of inOrder(lines.map(line => slash(line).replace(/^\.\//, '')).filter(Boolean), file => file)) {
      const seen = visibleFile(project, file, cache);
      if (!seen) { withheld++; continue; }
      if (items.length >= limit) { truncated = true; break; }
      items.push({ path: file, size: seen.size });
    }
    return { items, truncated, ...(withheld ? { withheld } : {}) };
  }

  async function search(project, input = {}) {
    if (typeof input.query !== 'string' || !input.query || input.query.includes('\0') || input.query.length > 4000) throw error('invalid_input', 'A query of up to 4000 characters is required.');
    const base = relativeInput(input.path || '.');
    if (!fs.statSync(resolveProjectPath(project, base)).isDirectory()) throw error('not_directory', 'Search requires a directory.');
    const limit = bounded(input.limit, 200, 1000), items = [], cache = new Map();
    const args = ['--json', '--max-filesize', String(READ_FILE_BYTES), '--max-count', String(limit), ...scanArguments(input)];
    if (!input.regex) args.push('--fixed-strings');
    if (input.ignoreCase) args.push('--ignore-case');
    const result = await invoke('rg', [...args, '-e', input.query, '--', base], projectRoot(project), scanned(input));
    scanFailure(result, result.stdout.includes('"type":"match"'));
    let truncated = result.stdoutTruncated;
    const hits = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      let record; try { record = JSON.parse(line); } catch { truncated = true; continue; }
      if (record.type !== 'match' || !record.data.path.text || typeof record.data.lines.text !== 'string') continue;
      hits.push({ path: slash(record.data.path.text).replace(/^\.\//, ''), line: record.data.line_number, text: record.data.lines.text.replace(/\r?\n$/, '') });
    }
    // The hits of a file come together and in the order of its lines; the files are put in order here.
    for (const hit of inOrder(hits, hit => hit.path)) {
      if (!visibleFile(project, hit.path, cache)) continue;
      if (items.length === limit) { truncated = true; break; }
      items.push({ path: hit.path, line: hit.line, text: hit.text.length > 2000 ? hit.text.slice(0, 2000) + ' [line cut; ' + hit.text.length + ' characters]' : hit.text });
    }
    return { items, truncated };
  }

  // Names are not secrets: a protected file is listed so nobody stages it by accident, marked so nobody tries to open it.
  async function gitStatus(project, input = {}) {
    const result = checkedCommand(await git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], input));
    if (result.stdoutTruncated) throw error('output_limit', 'Git status exceeds the output bound.');
    const records = result.stdout.split('\0'), items = [], verified = new Map();
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (!record) continue;
      const status = record.slice(0, 2), file = slash(record.slice(3)).replace(/\/$/, '');
      const originalPath = /[RC]/.test(status) ? slash(records[++i] || '') : null;
      // Entries Git reports but DevMate cannot address (links, instance storage, device names) are left out, not fatal.
      if (!listable({ ...project, protectSecrets: false }, file, { mustExist: false, verified })) continue;
      const guarded = hidden(project, file) || (originalPath ? hidden(project, originalPath) : false);
      items.push({ path: file, status, ...(originalPath ? { originalPath } : {}), ...(guarded ? { protected: true } : {}) });
    }
    return { exitCode: result.exitCode, items,
      stdout: items.map(item => item.status + ' ' + item.path + (item.protected ? '  [protected: do not commit]' : '')).join('\n') };
  }

  async function changedPaths(project, args, input, scopes = []) {
    const names = checkedCommand(await git(project, [...args, '--name-only', '-z', ...(scopes.length ? ['--', ...scopes] : [])], { ...input, maxOutputChars: 2000000 }));
    if (names.stdoutTruncated) throw error('output_limit', 'The changed-file list exceeds the output bound; name the paths you need.');
    const all = names.stdout.split('\0').map(item => item.trim()).filter(Boolean), verified = new Map();
    const shown = all.filter(item => !hidden(project, item) && listable(project, item, { mustExist: false, verified }));
    return { shown, omitted: all.length - shown.length };
  }
  // A diff is read from the top, so an oversized one keeps its beginning and says what is missing.
  function patch(result, omitted) {
    const stdout = result.stdout.length > DIFF_CHAR_LIMIT
      ? result.stdout.slice(0, DIFF_CHAR_LIMIT) + '\n[diff cut after ' + DIFF_CHAR_LIMIT + ' of ' + result.stdout.length + ' characters; pass paths to see the rest]' : result.stdout;
    return { exitCode: result.exitCode, stdout: stdout + (omitted ? '\n[' + omitted + ' protected file(s) changed and are not shown]' : ''), omittedProtected: omitted,
      truncated: result.stdout.length > DIFF_CHAR_LIMIT || result.stdoutTruncated };
  }

  async function gitDiff(project, input = {}) {
    const requested = input.paths || [];
    if (!Array.isArray(requested) || requested.length > 100) throw error('invalid_input', 'paths must contain up to 100 relative paths.');
    const scopes = requested.map(p => { const rel = relativeInput(p); resolveProjectPath(project, rel, { mustExist: false }); return rel; });
    const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...(input.staged ? ['--cached'] : [])];
    const { shown, omitted } = await changedPaths(project, base, input, scopes);
    if (!shown.length) return patch(emptyCommand(), omitted);
    if (shown.reduce((n, p) => n + p.length + 3, 0) > 20000) throw error('output_limit', 'Too many files changed for one diff; pass the paths you need.');
    return patch(checkedCommand(await git(project, [...base, '--', ...shown], { ...input, maxOutputChars: 2000000 })), omitted);
  }

  // What is not committed yet, for review: per file what happened to it and how many lines came and went, against
  // the last commit. A new file that Git does not ignore counts as added. With since:'last_review' what was already
  // shown and marked (markReviewed) is left out, judged by each file's content now: nothing new, nothing shown.
  async function changes(project, input = {}) {
    // Three questions that do not wait for one another; each is a process of its own.
    const [inside, head, listed] = await Promise.all([git(project, ['rev-parse', '--is-inside-work-tree'], input), git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], input),
      git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { ...input, maxOutputChars: 2000000 })]);
    if (inside.exitCode !== 0)
      throw error('not_a_repository', 'This project is not a Git repository, so there is no commit to compare it with. workspace_history lists what DevMate\'s own tools changed here, and workspace_restore takes it back.');
    const base = head.exitCode === 0 ? 'HEAD' : EMPTY_TREE;
    const status = checkedCommand(listed);
    if (status.stdoutTruncated) throw error('output_limit', 'Too many files changed to list them here; look at them with git_status and git_diff.');
    const files = new Map(), untracked = new Set(), verified = new Map();
    let omittedProtected = 0;
    const records = status.stdout.split('\0');
    for (let index = 0; index < records.length; index++) {
      const record = records[index]; if (!record) continue;
      const code = record.slice(0, 2), file = slash(record.slice(3)), previousPath = /[RC]/.test(code) ? slash(records[++index] || '') : null;
      if (hidden(project, file) || (previousPath && hidden(project, previousPath))) { omittedProtected++; continue; }
      if (!listable(project, file, { mustExist: false, verified })) continue;
      if (code === '??') untracked.add(file);
      files.set(file, { path: file, ...(previousPath ? { previousPath } : {}), type: code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : previousPath ? 'renamed' : 'modified', additions: 0, removals: 0 });
    }
    if (files.size > untracked.size) {
      // "added<TAB>removed<TAB>path", and for a rename an empty path followed by the old and the new one.
      const counted = checkedCommand(await git(project, ['diff', '--no-ext-diff', '--no-textconv', '-M', '--numstat', '-z', base, '--'], { ...input, maxOutputChars: 2000000 })).stdout.split('\0');
      for (let index = 0; index < counted.length; index++) {
        const [added, removed, name] = counted[index].split('\t');
        if (removed === undefined) continue;
        const file = files.get(slash(name || (index += 2, counted[index])));
        if (file) Object.assign(file, added === '-' ? { binary: true } : { additions: Number(added), removals: Number(removed) });
      }
    }
    // Looked at once more now that nothing is waited for any longer: the files are read from where the project is at
    // this moment, not from where it was before Git was asked.
    const root = projectRoot(project);
    // What a file holds now, in a form that is cheap to compare later.
    const state = item => {
      const stat = item.type === 'deleted' ? null : fs.lstatSync(path.join(root, item.path), { throwIfNoEntry: false });
      if (!stat?.isFile()) return 'absent';
      return stat.size <= MAX_FILE_BYTES ? hash(readRegular(path.join(root, item.path), { linked: true })) : stat.size + ':' + stat.mtimeMs;
    };
    for (const item of files.values()) {
      item.state = state(item);
      // Git counts no lines for a file it does not track yet.
      if (untracked.has(item.path) && item.state.length === 64) {
        const bytes = readRegular(path.join(root, item.path), { linked: true });
        if (bytes.includes(0)) item.binary = true; else if (bytes.length) item.additions = bytes.toString('utf8').split('\n').length - (bytes.at(-1) === 10 ? 1 : 0);
      }
    }
    const key = 'changes.reviewed.' + project.id, reviewed = store?.setting?.(key) || {};
    const since = input.since === 'last_commit' ? 'last_commit' : 'last_review';
    const all = [...files.values()], shown = since === 'last_commit' ? all : all.filter(item => reviewed[item.path] !== item.state);
    if (input.markReviewed && store?.setting) store.setting(key, Object.fromEntries(all.slice(0, 5000).map(item => [item.path, item.state])));
    return { since, files: shown.slice(0, 500).map(({ state, ...item }) => item), ...(shown.length > 500 ? { moreFiles: shown.length - 500 } : {}),
      additions: shown.reduce((sum, item) => sum + item.additions, 0), removals: shown.reduce((sum, item) => sum + item.removals, 0),
      ...(since === 'last_review' && all.length > shown.length ? { alreadyReviewed: all.length - shown.length } : {}), ...(omittedProtected ? { omittedProtected } : {}),
      ...(input.markReviewed ? { markedReviewed: all.length } : {}) };
  }

  // An agent can be given a copy of the project to work in: a Git worktree on a branch of its own, kept beside the
  // instance directory and not inside it: a program that runs whatever it is asked to has no business two folders
  // away from the owner token and the stored credentials. The project sees nothing of what happens in a copy until
  // that work is applied, all of it or none.
  // Git that changes something runs here with the repository's hooks off and its attributes on: the copy has to look
  // like the owner's own checkout.
  const gitChange = (cwd, args, input = {}, extra = {}) => invoke('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + gitNull, '-c', 'core.quotePath=false',
    '-c', 'color.ui=false', '-c', 'commit.gpgsign=false', ...(WINDOWS ? ['-c', 'core.longpaths=true'] : []), ...args], cwd, { timeoutMs: 120000, ...input },
  { ...toolEnvironment(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_PAGER: 'cat', PAGER: 'cat', ...extra });
  // Where this runtime keeps the copies of a project: beside its instance directory.
  const copiesRoot = project => path.join(path.dirname(project.controlRoot), path.basename(project.controlRoot) + '-copies');
  // The copy as a project of its own for reading: the same rules about what may be shown, another folder. That folder
  // is one of the runtime's own copies or it is not read: what lets it past the rule for shared folders is where it is.
  const inCopy = (project, copy) => {
    const root = path.resolve(String(copy?.root || '')), name = project.controlRoot ? path.relative(copiesRoot(project), root) : '';
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name)) throw error('invalid_input', 'This is not a working copy this DevMate made for an agent.');
    return { ...project, root, controlRoot: null, [OWN_COPY]: true };
  };
  const copyExists = copy => { if (!copy?.root || !fs.existsSync(copy.root)) throw error('not_found', 'This agent has no working copy of its own (any more).'); };

  async function isolate(project, name) {
    writable(project);
    if (!/^[A-Za-z0-9-]{1,80}$/.test(name) || !project.controlRoot) throw error('invalid_input', 'A working copy needs a plain name.');
    const head = await git(project, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']), base = head.stdout.trim();
    if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(base)) throw error('not_a_repository', 'A copy of its own needs a Git repository with at least one commit: what the agent proposes is what differs from that commit.');
    // A project that is one folder of a larger repository gets no copy (folderInRepository says why).
    const within = await folderInRepository(project);
    if (within) throw error('not_repository_root', 'A copy of its own needs the project to be the top folder of its Git repository: this project is the folder ' + within + ' inside one. Delegate without isolate, or share the repository\'s top folder as the project.');
    const root = path.join(copiesRoot(project), name), branch = 'devmate/' + name;
    fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 });
    checkedCommand(await gitChange(projectRoot(project), ['worktree', 'add', '--quiet', '-b', branch, root, base]));
    // What is not committed is not in the copy; whoever delegates is told how much that is.
    return { root, branch, base, uncommitted: (await gitStatus(project)).items.length };
  }

  // What the copy holds that the commit it started from does not, files the agent created included.
  async function proposal(project, copy, input = {}) {
    copyExists(copy);
    await ofWholeProject(project, copy);
    const view = inCopy(project, copy), base = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', copy.base];
    // The copy's index is the agent's, and the agent may be running Git this very moment: what it proposes is worked
    // out in an index of its own, started from the copy's so that only what changed is read again.
    const scratch = copy.root + '.index-' + randomUUID(), own = { GIT_INDEX_FILE: scratch };
    try {
      const index = (await git(view, ['rev-parse', '--git-path', 'index'])).stdout.trim();
      try { if (index) fs.copyFileSync(path.resolve(copy.root, index), scratch); } catch { /* an empty index compares everything, which is slower and as right */ }
      checkedCommand(await gitChange(copy.root, ['add', '--all', '.'], {}, own));
      const listed = checkedCommand(await git(view, [...base, '--name-status', '-z'], { ...input, maxOutputChars: 2000000 }, own));
      if (listed.stdoutTruncated) throw error('output_limit', 'The list of changed files exceeds the output bound.');
      const records = listed.stdout.split('\0'), all = [];
      for (let index = 0; index + 1 < records.length; index += 2) all.push({ status: records[index].slice(0, 1), path: slash(records[index + 1]) });
      const files = all.filter(file => !hidden(project, file.path)), omitted = all.length - files.length;
      if (input.namesOnly) return { branch: copy.branch, base: copy.base, files, omittedProtected: omitted };
      const wanted = (input.paths || []).map(relativeInput), shown = (wanted.length ? files.filter(file => wanted.includes(file.path)) : files).map(file => file.path);
      const tooMany = shown.reduce((size, file) => size + file.length + 3, 0) > 20000;
      const diff = !shown.length || tooMany ? emptyCommand() : checkedCommand(await git(view, [...base, '--', ...shown], { ...input, maxOutputChars: 2000000 }, own));
      const text = patch(diff, omitted);
      return { branch: copy.branch, base: copy.base, files, ...text, ...(tooMany ? { stdout: '[' + shown.length + ' files changed, too many for one diff: name some of them with paths]' + text.stdout } : {}) };
    } finally { for (const file of [scratch, scratch + '.lock']) fs.rmSync(file, { force: true }); }
  }

  async function removeCopy(project, copy) {
    const root = projectRoot(project);
    if (fs.existsSync(copy.root)) {
      // Where the owner has switched on Git's own file watcher (core.fsmonitor), the agent's Git starts one in the
      // copy, and it stays when the agent has gone, with the folder open (seen with the real Codex on Windows, where
      // such a folder cannot be removed). It is told to end first. A Git that has none, and a copy nobody watches,
      // answer with an error that says nothing here.
      await gitChange(copy.root, ['fsmonitor--daemon', 'stop'], { timeoutMs: 15000 }).catch(() => {});
      const removed = await gitChange(root, ['worktree', 'remove', '--force', copy.root]);
      // Whatever Git would not remove (a file held open by a program that is still running) must not be reported as gone.
      if (removed.exitCode !== 0 && fs.existsSync(copy.root)) {
        try { fs.rmSync(copy.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        catch { throw error('copy_in_use', 'The working copy is still in use and could not be removed. Stop the agent (agents.stop) and try again.'); }
      }
    }
    await gitChange(root, ['worktree', 'prune']);
    await gitChange(root, ['branch', '-D', copy.branch]);
  }

  // One file as it was before something was applied to it (was: whether it existed, the hash it was kept under and
  // its mode). False where that cannot be done: it existed and was not kept (a link, a file with a second name, one
  // that could not be looked at). Only a file that was seen not to be there is removed.
  function putBack(project, file, was) {
    const full = resolveProjectPath(project, file, { mustExist: false }), stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!was.existed) { if (stat) fs.rmSync(full, { force: true }); return true; }
    if (!was.sha256) return false;
    const same = stat?.isFile() && contentHash(full, stat.size) === was.sha256;
    if (!same) { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.copyFileSync(snapshotPath(project, was.sha256), full); }
    // The mode as well as the bytes. What is kept is kept for the owner alone (0600), and a copy takes that mode with
    // it; and Git may have changed nothing of a file but its mode (a script that was made to run). Either way the
    // file gets back the mode it had, or Git would show a change where "as it was" was said.
    if (!WINDOWS && (!same || (stat.mode & 0o777) !== was.mode)) fs.chmodSync(full, was.mode);
    return true;
  }
  // A copy is a worktree, which is the whole repository. Of a project that is one folder of a repository nothing here
  // would be right: the agent would stand in the repository's top folder, Git applies a patch from inside a folder
  // to that folder only and is silent about the rest, and what was applied would be looked for one folder too deep.
  // The folder such a project is inside its repository, or '' where it is the top.
  const folderInRepository = async project => (await git(project, ['rev-parse', '--show-prefix'])).stdout.trim().replace(/\/$/, '');
  // A copy that was made for such a project before that was refused may still be there, for an agent that was never
  // settled. It is neither shown nor applied (what lies outside the folder would be lost, and the copy removed with
  // it); it can be discarded.
  const ofWholeProject = async (project, copy) => {
    const within = await folderInRepository(project);
    if (within) throw error('not_repository_root', 'This agent\'s copy is of a whole Git repository, of which the project is only the folder ' + within + ': what the agent did cannot be shown or applied rightly from here. ' +
      'Its work is in ' + copy.root + ' (branch ' + copy.branch + '): commit it there and merge it with Git yourself, or drop it with agents.discard.');
  };

  // The agent's work arrives in the project as changes in the working tree, not as a commit: the person reviews and
  // commits it like their own. All of it or none of it; on success the copy has done its job and is removed.
  async function applyProposal(project, copy) {
    writable(project); copyExists(copy);
    await ofWholeProject(project, copy);
    const view = inCopy(project, copy);
    checkedCommand(await gitChange(copy.root, ['add', '--all', '.']));
    const names = checkedCommand(await git(view, ['diff', '--cached', '--no-renames', '--name-only', '-z', copy.base], { maxOutputChars: 2000000 }));
    const files = names.stdout.split('\0').filter(Boolean).map(slash);
    if (!files.length) { await removeCopy(project, copy); return { applied: false, files: [], note: 'The agent changed nothing. Its copy was removed.' }; }
    const guarded = files.filter(file => hidden(project, file));
    if (guarded.length) throw error('protected_content', 'The agent changed files this project protects (' + guarded.slice(0, 5).join(', ') + '). Nothing was applied; its work stays in its copy.');
    // What is about to change is kept first, as with every change these tools make: taking back everything after a
    // point in the history then takes the agent's work back with it.
    const before = new Map(files.map(file => {
      try {
        const full = resolveProjectPath(project, file, { mustExist: false }), stat = fs.lstatSync(full, { throwIfNoEntry: false });
        if (!stat) return [file, { existed: false, sha256: null }];
        // A file with a second name shares its bytes with a path that may lie outside the project: never copied into history.
        return [file, { existed: true, mode: stat.mode & 0o777, sha256: !stat.isFile() || stat.nlink !== 1 ? null : stat.size <= MAX_FILE_BYTES ? snapshot(project, readRegular(full)) : snapshotFile(project, full) }];
      // What could not be looked at (a link in the way, a file a program holds for a moment, no room left to keep it)
      // is not taken for a file that was not there: on that ground it would be deleted when the work is taken out
      // again. It is there and not kept, and is named where that matters. Only a path below something that is a file
      // (the work makes a folder of that file) is known to have nothing at it.
      } catch (failure) { return [file, { existed: !['not_directory', 'ENOTDIR', 'ENOENT'].includes(failure?.code), sha256: null }]; }
    }));
    const patchFile = copy.root + '.patch';
    try {
      checkedCommand(await gitChange(copy.root, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', '--output=' + patchFile, copy.base]));
      const root = projectRoot(project), fits = await gitChange(root, ['apply', '--check', '--whitespace=nowarn', patchFile]);
      if (fits.exitCode !== 0) {
        // Kept as a commit on the copy's branch, so the work can still be merged by hand.
        await gitChange(copy.root, ['-c', 'user.name=DevMate', '-c', 'user.email=devmate@localhost', 'commit', '--quiet', '--no-verify', '-m', 'Work of a delegated agent']);
        throw error('conflict', 'The project changed in the same places since the agent started, so its work does not apply cleanly. Nothing was applied. It is kept on the branch ' + copy.branch +
          ' (merge it with Git, or discard it with agents.discard). Git says: ' + String(fits.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 400));
      }
      const brought = await gitChange(root, ['apply', '--whitespace=nowarn', patchFile]);
      if (brought.exitCode !== 0) {
        // Git had checked the patch and then could not write all of it: on Windows a file another program has open
        // is neither replaced nor removed, and by then the files before it are written. All of it or none: what was
        // written or removed is put back from what was kept above, so that the project is as it was and the work,
        // which is still in the copy, can be applied again.
        const stuck = files.filter(file => { try { return !putBack(project, file, before.get(file)); } catch { return true; } });
        const said = String(brought.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' | ').slice(0, 400);
        if (stuck.length) throw Object.assign(error('apply_incomplete', 'The agent\'s work could not be brought into the project whole, and part of it could not be taken out again: ' + stuck.slice(0, 10).join(', ') + (stuck.length > 10 ? ', …' : '') +
          '. Look at these files (git diff). The work is still in the agent\'s copy. Git says: ' + said, { files: stuck }), { incomplete: true });
        throw error('apply_failed', 'The agent\'s work could not be brought into the project: Git could not write all of it. On Windows that is a file another program has open. What had been written by then was put back: the project is as it was, and the work is still in the agent\'s copy. Apply it again when the file is let go. Git says: ' + said);
      }
    } finally { fs.rmSync(patchFile, { force: true }); }
    let warning = null;
    // What is applied and cannot be recorded: a link (never followed, so never read), anything else that is no plain
    // file, and a file that was there and was not kept (recorded as written, with nothing before it, it would be
    // deleted when the work is taken back). It is in the project like the rest, and taking the work back does not
    // reach it: that is said.
    const unrecorded = [];
    const record = () => {
      for (const file of files) {
        const was = before.get(file);
        let stat = null, full = null;
        try { full = resolveProjectPath(project, file, { mustExist: false }); stat = fs.lstatSync(full, { throwIfNoEntry: false }); } catch { unrecorded.push(file); continue; }
        if (stat?.isFile() && was.existed && !was.sha256) unrecorded.push(file);
        else if (stat?.isFile()) warning ||= event(project, 'workspace.file.written', { path: file, sha256: contentHash(full, stat.size), written: true, previousSha256: was.sha256, proposal: copy.branch });
        else if (!stat && was.existed) warning ||= event(project, 'workspace.file.removed', { path: file, entry: 'file', previousSha256: was.sha256, proposal: copy.branch });
        else if (stat) unrecorded.push(file);
      }
    };
    if (store?.transaction) store.transaction(record); else record();
    // The work is in the project from here on. A copy that cannot be removed yet does not make that untrue: it is said,
    // with what is left and how it goes.
    let left = null;
    try { await removeCopy(project, copy); }
    catch (failure) { if (failure.code !== 'copy_in_use') throw failure; left = 'The copy it came from could not be removed, because a program still uses its folder: ' + copy.root + '. When nothing uses it any more, delete that folder and run "git worktree prune" and "git branch -D ' + copy.branch + '" in the project.'; }
    const notes = [unrecorded.length ? 'Applied, but not in the history (links, other entries that are no plain files, and files that were there and could not be kept): workspace_restore does not take these back. Use Git for them: ' + unrecorded.slice(0, 10).join(', ') + (unrecorded.length > 10 ? ', …' : '') : null, left].filter(Boolean);
    return { applied: true, files, ...(warning ? { warning } : {}), ...(unrecorded.length ? { notInHistory: unrecorded } : {}), ...(left ? { copyLeft: true } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
  }
  async function discardProposal(project, copy) {
    await removeCopy(project, copy);
    return { discarded: true, branch: copy.branch };
  }

  async function gitLog(project, input = {}) {
    const scopes = (input.paths || []).map(p => { const rel = relativeInput(p); resolveProjectPath(project, rel, { mustExist: false }); return rel; });
    // One more than asked for, to be able to say that there are more.
    const limit = bounded(input.limit, 20, 200);
    const args = ['log', '--no-show-signature', '--max-count=' + (limit + 1), '--date=iso-strict', '--pretty=format:%H%x09%an%x09%ad%x09%s'];
    if (input.ref) args.push(await commitOf(project, input.ref, input));
    const result = checkedCommand(await git(project, [...args, '--', ...scopes], input));
    const items = result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const [commit, author, date, ...subject] = line.split('\t');
      return { commit, author, date, subject: subject.join('\t') };
    });
    return { items: items.slice(0, limit), truncated: result.stdoutTruncated, more: items.length > limit || result.stdoutTruncated };
  }
  async function gitShow(project, input = {}) {
    const commit = await commitOf(project, input.ref || 'HEAD', input);
    const header = ['show', '--no-show-signature', '--no-ext-diff', '--no-textconv', '--no-renames', '--date=iso-strict'];
    const { shown, omitted } = await changedPaths(project, ['show', '--no-show-signature', '--pretty=format:', '--no-renames', commit], input);
    if (!shown.length || shown.reduce((n, p) => n + p.length + 3, 0) > 20000) {
      return patch(checkedCommand(await git(project, [...header, shown.length ? '--stat' : '--no-patch', commit], input)), omitted);
    }
    return patch(checkedCommand(await git(project, [...header, ...(input.stat ? ['--stat'] : []), commit, '--', ...shown], { ...input, maxOutputChars: 2000000 })), omitted);
  }
  async function gitBlame(project, input = {}) {
    const rel = relativeInput(input.path);
    resolveProjectPath(project, rel);
    const args = ['blame', '--date=short'];
    if (input.startLine !== undefined || input.endLine !== undefined) {
      const start = bounded(input.startLine, 1, 10000000), end = bounded(input.endLine, start + 199, 10000000);
      if (end < start) throw error('invalid_range', 'endLine must not precede startLine.');
      args.push('-L', start + ',' + end);
    }
    if (input.ref) args.push(await commitOf(project, input.ref, input));
    // A blame is read from the top, like a diff: a long one keeps its beginning and says how to get the rest.
    const result = checkedCommand(await git(project, [...args, '--', rel], { ...input, maxOutputChars: 2000000 }));
    const lines = result.stdout.split('\n');
    let kept = 0, size = 0;
    while (kept < lines.length && size + lines[kept].length + 1 <= BLAME_CHAR_LIMIT) size += lines[kept++].length + 1;
    const cut = kept < lines.length && lines.slice(kept).some(Boolean);
    return { exitCode: result.exitCode, stdout: cut ? lines.slice(0, kept).join('\n') + '\n[' + kept + ' lines shown; pass startLine and endLine for the lines after them]' : result.stdout,
      truncated: cut || result.stdoutTruncated };
  }
  async function gitBranches(project, input = {}) {
    const result = checkedCommand(await git(project, ['branch', '--all', '--format=%(HEAD)%09%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(subject)'], input));
    const items = result.stdout.split(/\r?\n/).filter(Boolean).map(line => {
      const [head, name, commit, upstream, ...subject] = line.split('\t');
      return { name, current: head === '*', commit, ...(upstream ? { upstream } : {}), subject: subject.join('\t') };
    });
    return { items, current: items.find(item => item.current)?.name || null };
  }
  const isRepository = project => fs.existsSync(path.join(projectRoot(project), '.git'));
  return { quickly, files, read, readBytes: readBytePage, write, edit, applyPatch, changes, mkdir, move, remove, find, history, restore, search,
    gitStatus, gitDiff, gitLog, gitShow, gitBlame, gitBranches, isRepository, isolate, proposal, applyProposal, discardProposal };
}
