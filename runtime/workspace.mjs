import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from './store.mjs';
import { assertSafeWorkspaceRoot, assertSafeWorkspacePath, isSensitiveWorkspacePath } from './platform/sensitive-path-policy.mjs';
import { executeCommand } from './platform/command-process.mjs';
import { resolveTool } from './platform/tools.mjs';
import { replaceFile } from './platform/atomic-write.mjs';

const WINDOWS = process.platform === 'win32';
const CASE_INSENSITIVE = WINDOWS || process.platform === 'darwin';
const gitNull = WINDOWS ? 'NUL' : '/dev/null';
// Git's well-known empty tree: reading attributes from it means no repository
// .gitattributes can attach a filter, textconv or external diff driver.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20000;
const READ_CHAR_LIMIT = 256000;
// Text files up to this size are read (a page at a time) and searched; editing has the smaller limit of MAX_FILE_BYTES.
const READ_FILE_BYTES = 32 * 1024 * 1024;
const BLAME_CHAR_LIMIT = 120000;
const READ_LINE_LIMIT = 2000;
const DIFF_CHAR_LIMIT = 200000;
const DELETE_SNAPSHOT_FILES = 2000;
const DELETE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HISTORY_EVENTS = ['workspace.file.written', 'workspace.file.removed', 'workspace.file.moved'];
// Dependency and build output that find/search skip unless includeIgnored is set.
const skippedDirectories = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', 'coverage']);
const unlistable = new Set(['unsafe_path', 'unsafe_file', 'outside_project', 'invalid_path', 'protected_workspace_path', 'protected_instance_path', 'not_found']);
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.replace(/\\/g, '/');
const error = (code, message, details) => new DomainError(code, message, details);
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const inside = (root, target) => {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
};
// A project protects credential-like files unless its owner turned that off.
const protects = project => project.protectSecrets !== false;
const hidden = (project, rel) => protects(project) && isSensitiveWorkspacePath(rel);

function projectRoot(project) {
  if (!project || typeof project.id !== 'string' || !path.isAbsolute(project.root || '') || !['read', 'write'].includes(project.access)) {
    throw error('invalid_project', 'A project with an absolute root and read/write access is required.');
  }
  assertSafeWorkspaceRoot(project.root);
  // A registered directory that has since been swapped for a link would silently redirect every file tool.
  if (fs.lstatSync(project.root).isSymbolicLink()) throw error('unsafe_root', 'The project directory was replaced by a link. Register the real directory again.');
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
// `verified` lets one listing check each folder once instead of once per file in it: a find over two thousand
// files would otherwise ask the file system the same questions about the same few folders thousands of times.
// It is a Map that lives for a single call.
// links: reading may go through a link or junction whose target is still inside the project (a package manager's
// node_modules is made of them). The canonical target is what is judged, so a link is never a way out of the project
// or around the credential protection. Everything that changes a file leaves links alone, as before.
export function resolveProjectPath(project, value = '.', { mustExist = true, policy = true, verified = null, links = false } = {}) {
  const root = projectRoot(project);
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
      failure.message += ' This project keeps credential-like files and folders out of the file tools. Its owner can lift that for the project on their own computer; until then work without this path.';
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
      ' MiB that can be handled here. Look at a part of it with a command (for example its last lines), or page its bytes with operations_call workspace.read_bytes.');
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
  if (bytes.includes(0)) throw error('binary_file', 'This is a binary file, not text. Its bytes can be paged with operations_call workspace.read_bytes.');
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

export function createWorkspaceService({ store } = {}) {
  // Bookkeeping must never turn a change that already happened into a reported failure.
  const event = (project, type, data) => {
    try { store?.event(type, { id: project.id, projectId: project.id }, data); return null; }
    catch (failure) { return 'The change was made, but recording it in history failed: ' + failure.message; }
  };
  const invoke = (file, args, cwd, input = {}, environment = toolEnvironment()) => executeCommand(resolveTool(file), args, {
    cwd, shell: false, environment, signal: input.signal || null,
    timeoutMs: bounded(input.timeoutMs, 30000, 300000), maxOutputChars: bounded(input.maxOutputChars, 120000, 2000000)
  });
  // Read-only Git that cannot run anything the repository itself configures:
  // no hooks, fsmonitor, pager, signature program, external diff, and attributes
  // read from the empty tree so no filter or textconv driver applies. The
  // owner's own system and global configuration (autocrlf, excludes, safe.directory) stays in effect.
  const git = (project, args, input) => invoke('git', [
    '--no-pager', '--attr-source=' + EMPTY_TREE, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=' + gitNull,
    '-c', 'core.quotePath=false', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...args
  ], projectRoot(project), input, { ...toolEnvironment(), GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat', PAGER: 'cat', GIT_LITERAL_PATHSPECS: '1' });
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
    const items = [];
    let withheld = 0;
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (entry.name <= after || entry.name.startsWith('.devmate-write-') || entry.name === '.git') continue;
      const childRel = path.posix.join(rel, entry.name);
      // What cannot be read is not listed either, but it is counted: an entry that silently is not there sends a model looking for it.
      if (hidden(project, childRel) || !listable(project, childRel, { links: true })) { withheld++; continue; }
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

  function read(project, input = {}) {
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
    if (input.startLine === undefined && input.lineCount === undefined && text.length <= READ_CHAR_LIMIT) {
      return { path: rel, text, sha256, totalLines, startLine: 1, endLine: totalLines, truncated: false, partial: false, ...(foreign ? { encoding, note: foreign } : {}) };
    }
    if (input.startLine !== undefined && input.startLine > totalLines) throw error('invalid_range', 'startLine exceeds the ' + totalLines + ' lines of this file.');
    const startLine = bounded(input.startLine, 1, totalLines);
    const wanted = bounded(input.lineCount, READ_LINE_LIMIT, 20000);
    const selected = [];
    let size = 0, longLine = null;
    for (let index = startLine - 1; index < totalLines && selected.length < wanted; index++) {
      if (selected.length && size + lines[index].length > READ_CHAR_LIMIT) break;
      if (lines[index].length > READ_CHAR_LIMIT) longLine ??= index + 1;
      selected.push(lines[index].length > READ_CHAR_LIMIT ? lines[index].slice(0, READ_CHAR_LIMIT) : lines[index]);
      size += lines[index].length + 1;
    }
    const endLine = startLine + selected.length - 1;
    // sha256 always identifies the whole file, so a page can still guard an edit.
    return { path: rel, text: selected.join('\n'), sha256, totalLines, startLine, endLine,
      truncated: longLine !== null || endLine < totalLines, partial: startLine > 1 || endLine < totalLines, ...(endLine < totalLines ? { nextStartLine: endLine + 1 } : {}),
      ...(foreign ? { encoding } : {}),
      ...(longLine !== null || foreign ? { ...(longLine !== null ? { cutLine: longLine } : {}), note: [foreign, longLine !== null ? 'Line ' + longLine + ' is longer than ' + READ_CHAR_LIMIT + ' characters and was cut; its bytes can be paged with operations_call workspace.read_bytes.' : null].filter(Boolean).join(' ') } : {}) };
  }

  function readBytePage(project, input = {}) {
    const full = resolveProjectPath(project, input.path, { links: true });
    const before = fs.lstatSync(full, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink())
      throw error('unsafe_file', 'Only regular project files are readable.');
    const offset = input.offset ?? 0;
    const length = input.length ?? 65536;
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(length) || length < 1 || length > 256 * 1024)
      throw error('invalid_range', 'Use a nonnegative safe offset and a page of at most 256 KiB.');
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
      if (current !== null) replaceFile(temp, full);
      else {
        // Create must never replace a file that appeared meanwhile. Hard links do that
        // atomically; filesystems without them (exFAT, some network shares) use an exclusive copy.
        try { fs.linkSync(temp, full); }
        catch (failure) {
          if (failure.code === 'EEXIST') throw error('conflict', 'File changed before publication.');
          fs.copyFileSync(temp, full, fs.constants.COPYFILE_EXCL);
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
      replacedSha256 = snapshot(project, readBytes(target));
    }
    fs.renameSync(source, caseOnly ? path.join(path.dirname(source), path.posix.basename(to)) : target);
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
      const previousSha256 = keep(full);
      fs.unlinkSync(full);
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
    if (failure) throw failure;
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

  function restore(project, input = {}) {
    writable(project);
    if (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256)) throw error('invalid_input', 'sha256 must identify a version from workspace_history.');
    const stored = snapshotPath(project, input.sha256);
    // The store is shared by content hash; a version is restorable only where this project recorded it.
    if (!stored || !fs.existsSync(stored) || !store?.hasFileVersion?.(project.id, HISTORY_EVENTS, input.sha256)) throw error('not_found', 'That version is not kept in this project\'s DevMate history.');
    const bytes = fs.readFileSync(stored);
    if (hash(bytes) !== input.sha256) throw error('history_corrupt', 'Stored history does not match its hash.');
    const rel = relativeInput(input.path);
    const full = resolveProjectPath(project, rel, { mustExist: false });
    if (fs.existsSync(full) && fs.lstatSync(full).size > MAX_FILE_BYTES) throw error('file_too_large', 'A file larger than ' + Math.round(MAX_FILE_BYTES / 1048576) + ' MiB is in the way at this path. Move or delete it first; deleting keeps it restorable too.');
    const current = fs.existsSync(full) ? hash(readBytes(full)) : null;
    return { ...publish(project, rel, bytes, current), restoredFrom: input.sha256 };
  }

  // ripgrep does the walking and all glob matching: it is fast on very large
  // trees, honours .gitignore and never follows links. DevMate then applies its
  // own path policy to every reported file before anything about it is returned.
  function scanArguments(input) {
    const glob = input.glob;
    if (glob !== undefined && (typeof glob !== 'string' || !glob || glob.length > 500 || /[\0\r\n]/.test(glob))) throw error('invalid_input', 'A glob pattern of up to 500 characters is required.');
    const args = ['--no-config', '--color', 'never', '--hidden', '--no-require-git', '--sort', 'path',
      ...(WINDOWS ? ['--glob-case-insensitive'] : [])];
    if (input.includeIgnored) args.push('--no-ignore');
    if (glob) args.push('--glob', slash(glob).replace(/^\.\//, ''));
    // Later globs win, so exclusions follow the caller's own pattern.
    for (const name of input.includeIgnored ? ['.git'] : skippedDirectories) args.push('--glob', '!' + name);
    return args;
  }
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
  function scanFailure(result, produced) {
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
    const result = await invoke('rg', ['--files', ...scanArguments({ ...input, glob: input.pattern }), '--', base], projectRoot(project), { ...input, maxOutputChars: 2000000 });
    scanFailure(result, !!result.stdout);
    let truncated = result.stdoutTruncated;
    for (const line of result.stdout.split(/\r?\n/)) {
      const file = slash(line).replace(/^\.\//, '');
      if (!file) continue;
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
    const result = await invoke('rg', [...args, '-e', input.query, '--', base], projectRoot(project), { ...input, maxOutputChars: 2000000 });
    scanFailure(result, result.stdout.includes('"type":"match"'));
    let truncated = result.stdoutTruncated;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      let record; try { record = JSON.parse(line); } catch { truncated = true; continue; }
      if (record.type !== 'match' || !record.data.path.text || typeof record.data.lines.text !== 'string') continue;
      const file = slash(record.data.path.text).replace(/^\.\//, '');
      if (!visibleFile(project, file, cache)) continue;
      if (items.length === limit) { truncated = true; break; }
      const hit = record.data.lines.text.replace(/\r?\n$/, '');
      items.push({ path: file, line: record.data.line_number, text: hit.length > 2000 ? hit.slice(0, 2000) + ' [line cut; ' + hit.length + ' characters]' : hit });
    }
    return { items, truncated };
  }

  // Names are not secrets: a protected file is listed so nobody stages it by accident, marked so nobody tries to open it.
  async function gitStatus(project, input = {}) {
    const result = checkedCommand(await git(project, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], input));
    if (result.stdoutTruncated) throw error('output_limit', 'Git status exceeds the output bound.');
    const records = result.stdout.split('\0'), items = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i]; if (!record) continue;
      const status = record.slice(0, 2), file = slash(record.slice(3)).replace(/\/$/, '');
      const originalPath = /[RC]/.test(status) ? slash(records[++i] || '') : null;
      // Entries Git reports but DevMate cannot address (links, instance storage, device names) are left out, not fatal.
      if (!listable({ ...project, protectSecrets: false }, file, { mustExist: false })) continue;
      const guarded = hidden(project, file) || (originalPath ? hidden(project, originalPath) : false);
      items.push({ path: file, status, ...(originalPath ? { originalPath } : {}), ...(guarded ? { protected: true } : {}) });
    }
    return { exitCode: result.exitCode, items,
      stdout: items.map(item => item.status + ' ' + item.path + (item.protected ? '  [protected: do not commit]' : '')).join('\n') };
  }

  async function changedPaths(project, args, input, scopes = []) {
    const names = checkedCommand(await git(project, [...args, '--name-only', '-z', ...(scopes.length ? ['--', ...scopes] : [])], { ...input, maxOutputChars: 2000000 }));
    if (names.stdoutTruncated) throw error('output_limit', 'The changed-file list exceeds the output bound; name the paths you need.');
    const all = names.stdout.split('\0').map(item => item.trim()).filter(Boolean);
    const shown = all.filter(item => !hidden(project, item) && listable(project, item, { mustExist: false }));
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
  return { files, read, readBytes: readBytePage, write, edit, mkdir, move, remove, find, history, restore, search,
    gitStatus, gitDiff, gitLog, gitShow, gitBlame, gitBranches, isRepository };
}
