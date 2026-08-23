import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;
const STALE_JOURNAL_TEMP_MS = 24 * 60 * 60 * 1000;
const JOURNAL_ID = /^ftx-[a-z0-9-]+$/i;
const JOURNAL_KINDS = new Set(['write-file', 'move-replace', 'delete-path']);

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function transactionError(message, code, journal = null, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (journal) {
    error.transactionId = journal.id || null;
    error.journalFile = journal.journalFile || null;
  }
  if (cause) error.cause = cause;
  return error;
}

function transactionId() {
  return `ftx-${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function existingAncestor(full) {
  let current = path.resolve(full);
  while (!fs.lstatSync(current, { throwIfNoEntry: false }) && current !== path.dirname(current)) {
    current = path.dirname(current);
  }
  return current;
}

function canonicalRoot(root) {
  const resolved = path.resolve(String(root || ''));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw transactionError(`Workspace root is unavailable for file transaction: ${resolved}`, 'FILE_TRANSACTION_WORKSPACE_UNAVAILABLE');
  }
  return fs.realpathSync.native(resolved);
}

function assertWorkspacePath(workspaceRoot, target, { allowMissing = true } = {}) {
  const root = path.resolve(String(workspaceRoot || ''));
  const full = path.resolve(String(target || ''));
  if (!isInside(root, full) || pathKey(root) === pathKey(full)) {
    throw transactionError(`File transaction path is outside the workspace: ${target}`, 'FILE_TRANSACTION_PATH_ESCAPE');
  }

  const rootReal = canonicalRoot(root);
  const direct = fs.lstatSync(full, { throwIfNoEntry: false });
  if (direct?.isSymbolicLink()) {
    throw transactionError(`File transaction refuses a symlink/reparse target: ${target}`, 'FILE_TRANSACTION_SYMLINK_TARGET');
  }
  if (!direct && !allowMissing) {
    throw transactionError(`File transaction source does not exist: ${target}`, 'FILE_TRANSACTION_SOURCE_MISSING');
  }

  const ancestor = direct ? path.dirname(full) : existingAncestor(path.dirname(full));
  const ancestorReal = fs.realpathSync.native(ancestor);
  if (!isInside(rootReal, ancestorReal)) {
    throw transactionError(`File transaction path escapes workspace root through a symlink/reparse point: ${target}`, 'FILE_TRANSACTION_PATH_ESCAPE');
  }
  if (direct) {
    const directReal = fs.realpathSync.native(full);
    if (!isInside(rootReal, directReal)) {
      throw transactionError(`File transaction target escapes workspace root: ${target}`, 'FILE_TRANSACTION_PATH_ESCAPE');
    }
  }
  return full;
}

function siblingPath(target, id, purpose) {
  return path.join(path.dirname(target), `.${path.basename(target)}.devmate-${purpose}-${id}`);
}

function journalPath(transactionRoot, id) {
  return path.join(path.resolve(transactionRoot), `${id}.json`);
}

function writeNewJournal(transactionRoot, document) {
  const root = path.resolve(String(transactionRoot || ''));
  if (!transactionRoot) throw new Error('transactionRoot is required');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  const file = journalPath(root, document.id);
  const payload = `${JSON.stringify({ ...document, journalFile: undefined }, null, 2)}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_JOURNAL_BYTES) {
    throw transactionError('File transaction journal exceeds its size bound', 'FILE_TRANSACTION_JOURNAL_TOO_LARGE', document);
  }
  const temporary = `${file}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
    fsyncDirectory(root);
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  document.journalFile = file;
  return file;
}

function removeJournal(journal) {
  if (!journal?.journalFile) return false;
  try {
    fs.rmSync(journal.journalFile, { force: true });
    fsyncDirectory(path.dirname(journal.journalFile));
    return true;
  } catch {
    return false;
  }
}

function parseJournal(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_JOURNAL_BYTES) {
    throw transactionError(`Invalid file transaction journal: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID');
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (cause) {
    throw transactionError(`Invalid file transaction journal JSON: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID', null, cause);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== JOURNAL_VERSION) {
    throw transactionError(`Unsupported file transaction journal: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID');
  }
  const id = String(value.id || '');
  if (!JOURNAL_ID.test(id) || !JOURNAL_KINDS.has(value.kind) || path.basename(file) !== `${id}.json`) {
    throw transactionError(`Invalid file transaction journal shape: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID');
  }
  return { ...value, journalFile: file };
}

function allowedRootKeys(workspaceRoots = []) {
  const keys = new Set();
  for (const root of workspaceRoots) {
    try { keys.add(pathKey(canonicalRoot(root))); } catch {}
  }
  return keys;
}

function validateJournalPaths(journal, workspaceRoots) {
  const workspaceRoot = path.resolve(String(journal.workspaceRoot || ''));
  const rootReal = canonicalRoot(workspaceRoot);
  if (!allowedRootKeys(workspaceRoots).has(pathKey(rootReal))) {
    throw transactionError(`File transaction references an inactive workspace: ${workspaceRoot}`, 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
  }

  const target = assertWorkspacePath(workspaceRoot, journal.target);
  const rollback = path.resolve(String(journal.rollback || ''));
  const expectedRollback = siblingPath(target, journal.id, 'rollback');
  if (pathKey(rollback) !== pathKey(expectedRollback)) {
    throw transactionError('File transaction rollback path does not match its target', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
  }
  assertWorkspacePath(workspaceRoot, rollback);

  let source = null;
  let temporary = null;
  if (journal.kind === 'move-replace') {
    source = assertWorkspacePath(workspaceRoot, journal.source);
  }
  if (journal.kind === 'write-file') {
    temporary = path.resolve(String(journal.temporary || ''));
    const expectedTemporary = siblingPath(target, journal.id, 'write');
    if (pathKey(temporary) !== pathKey(expectedTemporary)) {
      throw transactionError('File transaction temporary path does not match its target', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
    }
    assertWorkspacePath(workspaceRoot, temporary);
  }
  return { workspaceRoot, target, source, temporary, rollback };
}

async function removeIfPresent(file, { recursive = false } = {}) {
  if (!file || !fs.lstatSync(file, { throwIfNoEntry: false })) return true;
  try {
    await fsp.rm(file, { recursive, force: true });
    return true;
  } catch {
    return false;
  }
}

async function recoverWriteJournal(journal, paths) {
  const targetExists = !!fs.lstatSync(paths.target, { throwIfNoEntry: false });
  const rollbackExists = !!fs.lstatSync(paths.rollback, { throwIfNoEntry: false });
  const temporaryExists = !!fs.lstatSync(paths.temporary, { throwIfNoEntry: false });

  if (rollbackExists && targetExists) {
    if (temporaryExists) {
      throw transactionError(
        'Interrupted file replacement found a recreated target before the prepared write committed',
        'FILE_TRANSACTION_RECOVERY_BLOCKED',
        journal
      );
    }
    if (!(await removeIfPresent(paths.rollback))) {
      throw transactionError('Committed file replacement still has an undeletable rollback file', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
    }
    removeJournal(journal);
    return { id: journal.id, action: 'finish-committed-write' };
  }
  if (rollbackExists && !targetExists) {
    if (!temporaryExists) {
      throw transactionError(
        'Interrupted file replacement target disappeared after the prepared write was committed',
        'FILE_TRANSACTION_RECOVERY_BLOCKED',
        journal
      );
    }
    try {
      await fsp.rename(paths.rollback, paths.target);
      fsyncDirectory(path.dirname(paths.target));
    } catch (cause) {
      throw transactionError('Could not restore the previous file after interrupted replacement', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, cause);
    }
    await removeIfPresent(paths.temporary);
    removeJournal(journal);
    return { id: journal.id, action: 'rollback-interrupted-write' };
  }
  if (targetExists) {
    await removeIfPresent(paths.temporary);
    removeJournal(journal);
    return { id: journal.id, action: temporaryExists ? 'discard-uncommitted-write' : 'finish-direct-write' };
  }
  if (journal.targetExisted === false) {
    await removeIfPresent(paths.temporary);
    removeJournal(journal);
    return { id: journal.id, action: temporaryExists ? 'discard-uncommitted-create' : 'discard-prepared-create' };
  }
  throw transactionError('Interrupted file replacement has an ambiguous filesystem state', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
}

async function recoverMoveJournal(journal, paths) {
  const sourceExists = !!fs.lstatSync(paths.source, { throwIfNoEntry: false });
  const targetExists = !!fs.lstatSync(paths.target, { throwIfNoEntry: false });
  const rollbackExists = !!fs.lstatSync(paths.rollback, { throwIfNoEntry: false });

  if (rollbackExists && targetExists && !sourceExists) {
    if (!(await removeIfPresent(paths.rollback, { recursive: true }))) {
      throw transactionError('Committed move still has an undeletable rollback target', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
    }
    removeJournal(journal);
    return { id: journal.id, action: 'finish-committed-move' };
  }
  if (rollbackExists && !targetExists && sourceExists) {
    try {
      await fsp.rename(paths.rollback, paths.target);
      fsyncDirectory(path.dirname(paths.target));
    } catch (cause) {
      throw transactionError('Could not restore destination after interrupted move', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, cause);
    }
    removeJournal(journal);
    return { id: journal.id, action: 'rollback-interrupted-move' };
  }
  if (!rollbackExists && targetExists) {
    removeJournal(journal);
    return { id: journal.id, action: sourceExists ? 'finish-rolled-back-move' : 'finish-clean-move' };
  }
  throw transactionError('Interrupted move has an ambiguous filesystem state', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
}

async function recoverDeleteJournal(journal, paths) {
  const targetExists = !!fs.lstatSync(paths.target, { throwIfNoEntry: false });
  const rollbackExists = !!fs.lstatSync(paths.rollback, { throwIfNoEntry: false });
  if (targetExists && rollbackExists) {
    throw transactionError('Interrupted delete has both target and rollback paths', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
  }
  if (!targetExists && rollbackExists) {
    try {
      await fsp.rename(paths.rollback, paths.target);
      fsyncDirectory(path.dirname(paths.target));
    } catch (cause) {
      throw transactionError('Could not restore target after interrupted delete', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, cause);
    }
    removeJournal(journal);
    return { id: journal.id, action: 'rollback-interrupted-delete' };
  }
  removeJournal(journal);
  return { id: journal.id, action: targetExists ? 'discard-prepared-delete' : 'finish-committed-delete' };
}

export async function recoverFileTransactions({ transactionRoot, workspaceRoots = [] } = {}) {
  if (!transactionRoot) throw new Error('transactionRoot is required');
  const root = path.resolve(transactionRoot);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  let entries = await fsp.readdir(root, { withFileTypes: true });
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
    const file = path.join(root, entry.name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_JOURNAL_TEMP_MS) {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }

  entries = await fsp.readdir(root, { withFileTypes: true });
  const recovered = [];
  const blocked = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(root, entry.name);
    try {
      const journal = parseJournal(file);
      const paths = validateJournalPaths(journal, workspaceRoots);
      if (journal.kind === 'write-file') recovered.push(await recoverWriteJournal(journal, paths));
      else if (journal.kind === 'move-replace') recovered.push(await recoverMoveJournal(journal, paths));
      else recovered.push(await recoverDeleteJournal(journal, paths));
    } catch (error) {
      blocked.push({
        file,
        code: String(error?.code || 'FILE_TRANSACTION_RECOVERY_BLOCKED'),
        message: String(error?.message || error)
      });
    }
  }
  return { recovered, blocked };
}

function preparedJournal({ kind, transactionRoot, workspaceRoot, target, source = null, targetExisted = null }) {
  if (!JOURNAL_KINDS.has(kind)) throw new Error(`Unsupported file transaction kind: ${kind}`);
  const id = transactionId();
  const cleanTarget = assertWorkspacePath(workspaceRoot, target);
  const journal = {
    version: JOURNAL_VERSION,
    id,
    kind,
    workspaceRoot: path.resolve(workspaceRoot),
    source: source ? assertWorkspacePath(workspaceRoot, source, { allowMissing: false }) : null,
    target: cleanTarget,
    rollback: siblingPath(cleanTarget, id, 'rollback'),
    temporary: kind === 'write-file' ? siblingPath(cleanTarget, id, 'write') : null,
    targetExisted,
    createdAt: new Date().toISOString(),
    journalFile: null
  };
  writeNewJournal(transactionRoot, journal);
  return journal;
}

function targetWriteMode(journal, fallback = 0o666) {
  if (!journal?.targetExisted) return fallback;
  const stat = fs.statSync(journal.target, { throwIfNoEntry: false });
  if (!stat?.isFile()) {
    throw transactionError('Existing write target changed before commit', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
  }
  return stat.mode & 0o777;
}

function normalizeWriteMode(value) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new TypeError('File write mode must be an integer between 0 and 0777');
  }
  return value;
}

async function writeTempFile(journal, writer, { mode = null } = {}) {
  let handle = null;
  try {
    const createMode = mode == null ? targetWriteMode(journal) : mode;
    handle = await fsp.open(journal.temporary, 'wx', createMode);
    if (mode != null) {
      try { await handle.chmod(createMode); } catch {}
    }
    await writer(handle);
    try { await handle.sync(); } catch {}
    await handle.close();
    handle = null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function finalizeJournal(journal) {
  if (fs.lstatSync(journal.rollback, { throwIfNoEntry: false })) {
    if (!(await removeIfPresent(journal.rollback, { recursive: true }))) {
      return { transactionId: journal.id, cleanupPending: true, journalFile: journal.journalFile };
    }
  }
  removeJournal(journal);
  return { transactionId: journal.id, cleanupPending: false, journalFile: null };
}

async function recoverAfterFailure(journal, workspaceRoot, transactionRoot, message, error) {
  if (error?.code === 'FILE_TRANSACTION_RECOVERY_BLOCKED') throw error;
  const recovery = await recoverFileTransactions({ transactionRoot, workspaceRoots: [workspaceRoot] });
  if (recovery.blocked.some(item => item.file === journal.journalFile)) {
    throw transactionError(message, 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, error);
  }
  throw error;
}

async function commitPreparedWrite(journal) {
  assertWorkspacePath(journal.workspaceRoot, journal.target);
  try {
    await fsp.rename(journal.temporary, journal.target);
    fsyncDirectory(path.dirname(journal.target));
    return finalizeJournal(journal);
  } catch (directError) {
    if (!journal.targetExisted || !fs.lstatSync(journal.target, { throwIfNoEntry: false })) throw directError;
    try {
      assertWorkspacePath(journal.workspaceRoot, journal.target);
      await fsp.rename(journal.target, journal.rollback);
      fsyncDirectory(path.dirname(journal.target));
      assertWorkspacePath(journal.workspaceRoot, journal.target);
      await fsp.rename(journal.temporary, journal.target);
      fsyncDirectory(path.dirname(journal.target));
    } catch (cause) {
      if (!fs.lstatSync(journal.target, { throwIfNoEntry: false }) && fs.lstatSync(journal.rollback, { throwIfNoEntry: false })) {
        try {
          await fsp.rename(journal.rollback, journal.target);
          fsyncDirectory(path.dirname(journal.target));
          await removeIfPresent(journal.temporary);
          removeJournal(journal);
        } catch {
          throw transactionError('File replacement failed and automatic rollback could not be completed', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, cause);
        }
      }
      throw cause;
    }
    return finalizeJournal(journal);
  }
}

export async function atomicWriteText({
  transactionRoot,
  workspaceRoot,
  target,
  content,
  encoding = 'utf8',
  createDirs = true,
  mode = null
} = {}) {
  const cleanTarget = assertWorkspacePath(workspaceRoot, target);
  const targetExisted = !!fs.lstatSync(cleanTarget, { throwIfNoEntry: false });
  const requestedMode = normalizeWriteMode(mode);
  const journal = preparedJournal({ kind: 'write-file', transactionRoot, workspaceRoot, target: cleanTarget, targetExisted });
  try {
    if (createDirs) await fsp.mkdir(path.dirname(journal.target), { recursive: true });
    assertWorkspacePath(workspaceRoot, journal.target);
    await writeTempFile(
      journal,
      handle => handle.writeFile(String(content ?? ''), { encoding }),
      { mode: targetExisted ? null : requestedMode }
    );
    return await commitPreparedWrite(journal);
  } catch (error) {
    return recoverAfterFailure(journal, workspaceRoot, transactionRoot, 'File write failed and recovery requires manual intervention', error);
  }
}

export async function atomicCopyFile({
  transactionRoot,
  workspaceRoot,
  source,
  target,
  createDirs = true
} = {}) {
  const cleanTarget = assertWorkspacePath(workspaceRoot, target);
  const targetExisted = !!fs.lstatSync(cleanTarget, { throwIfNoEntry: false });
  const journal = preparedJournal({ kind: 'write-file', transactionRoot, workspaceRoot, target: cleanTarget, targetExisted });
  try {
    if (createDirs) await fsp.mkdir(path.dirname(journal.target), { recursive: true });
    assertWorkspacePath(workspaceRoot, journal.target);
    const sourceStat = await fsp.stat(path.resolve(source));
    if (!sourceStat.isFile()) throw new Error('Atomic copy source must be a file');
    const mode = targetExisted ? targetWriteMode(journal) : (sourceStat.mode & 0o777);
    await writeTempFile(journal, async handle => {
      const input = await fsp.open(path.resolve(source), 'r');
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          let offset = 0;
          while (offset < bytesRead) {
            const { bytesWritten } = await handle.write(buffer, offset, bytesRead - offset);
            if (!bytesWritten) throw new Error('Atomic copy made no forward progress');
            offset += bytesWritten;
          }
          position += bytesRead;
        }
      } finally {
        await input.close();
      }
    }, { mode });
    return await commitPreparedWrite(journal);
  } catch (error) {
    return recoverAfterFailure(journal, workspaceRoot, transactionRoot, 'File restore failed and recovery requires manual intervention', error);
  }
}

export async function transactionalMove({ transactionRoot, workspaceRoot, source, target, overwrite = false } = {}) {
  const cleanSource = assertWorkspacePath(workspaceRoot, source, { allowMissing: false });
  const cleanTarget = assertWorkspacePath(workspaceRoot, target);
  if (pathKey(cleanSource) === pathKey(cleanTarget)) return { transactionId: null, cleanupPending: false, noOp: true };

  const sourceStat = await fsp.stat(cleanSource);
  if (sourceStat.isDirectory() && isInside(cleanSource, cleanTarget)) {
    throw new Error('Cannot move a directory into itself');
  }
  const targetExists = !!fs.lstatSync(cleanTarget, { throwIfNoEntry: false });
  if (targetExists && !overwrite) throw new Error('Destination exists; pass overwrite=true');
  await fsp.mkdir(path.dirname(cleanTarget), { recursive: true });
  assertWorkspacePath(workspaceRoot, cleanTarget);

  if (!targetExists) {
    await fsp.rename(cleanSource, cleanTarget);
    fsyncDirectory(path.dirname(cleanSource));
    if (path.dirname(cleanSource) !== path.dirname(cleanTarget)) fsyncDirectory(path.dirname(cleanTarget));
    return { transactionId: null, cleanupPending: false, noOp: false };
  }

  const targetStat = await fsp.stat(cleanTarget);
  if (sourceStat.isFile() && targetStat.isFile()) {
    try {
      await fsp.rename(cleanSource, cleanTarget);
      fsyncDirectory(path.dirname(cleanSource));
      if (path.dirname(cleanSource) !== path.dirname(cleanTarget)) fsyncDirectory(path.dirname(cleanTarget));
      return { transactionId: null, cleanupPending: false, noOp: false };
    } catch {
    }
  }

  const journal = preparedJournal({
    kind: 'move-replace', transactionRoot, workspaceRoot,
    source: cleanSource, target: cleanTarget, targetExisted: true
  });
  try {
    assertWorkspacePath(workspaceRoot, cleanTarget);
    await fsp.rename(cleanTarget, journal.rollback);
    fsyncDirectory(path.dirname(cleanTarget));
    try {
      assertWorkspacePath(workspaceRoot, cleanSource, { allowMissing: false });
      assertWorkspacePath(workspaceRoot, cleanTarget);
      await fsp.rename(cleanSource, cleanTarget);
      fsyncDirectory(path.dirname(cleanSource));
      if (path.dirname(cleanSource) !== path.dirname(cleanTarget)) fsyncDirectory(path.dirname(cleanTarget));
    } catch (cause) {
      try {
        await fsp.rename(journal.rollback, cleanTarget);
        fsyncDirectory(path.dirname(cleanTarget));
        removeJournal(journal);
      } catch {
        throw transactionError('Move failed and the previous destination could not be restored automatically', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, cause);
      }
      throw cause;
    }
    return await finalizeJournal(journal);
  } catch (error) {
    return recoverAfterFailure(journal, workspaceRoot, transactionRoot, 'Move failed and recovery requires manual intervention', error);
  }
}

export async function transactionalDelete({ transactionRoot, workspaceRoot, target, backup = null } = {}) {
  const cleanTarget = assertWorkspacePath(workspaceRoot, target, { allowMissing: false });
  const journal = preparedJournal({ kind: 'delete-path', transactionRoot, workspaceRoot, target: cleanTarget, targetExisted: true });
  let backupResult = null;
  try {
    assertWorkspacePath(workspaceRoot, cleanTarget, { allowMissing: false });
    await fsp.rename(cleanTarget, journal.rollback);
    fsyncDirectory(path.dirname(cleanTarget));
    if (typeof backup === 'function') backupResult = await backup(journal.rollback);
    const rollbackStat = fs.lstatSync(journal.rollback, { throwIfNoEntry: false });
    if (rollbackStat) await fsp.rm(journal.rollback, { recursive: rollbackStat.isDirectory(), force: false });
    fsyncDirectory(path.dirname(cleanTarget));
    removeJournal(journal);
    return { transactionId: journal.id, cleanupPending: false, backupResult };
  } catch (error) {
    if (fs.lstatSync(journal.rollback, { throwIfNoEntry: false }) && !fs.lstatSync(cleanTarget, { throwIfNoEntry: false })) {
      try {
        await fsp.rename(journal.rollback, cleanTarget);
        fsyncDirectory(path.dirname(cleanTarget));
        removeJournal(journal);
      } catch (rollbackError) {
        throw transactionError('Delete failed and the target could not be restored automatically', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, rollbackError);
      }
    }
    return recoverAfterFailure(journal, workspaceRoot, transactionRoot, 'Delete failed and recovery requires manual intervention', error);
  }
}

export const __test = {
  JOURNAL_ID,
  JOURNAL_KINDS,
  JOURNAL_VERSION,
  MAX_JOURNAL_BYTES,
  STALE_JOURNAL_TEMP_MS,
  assertWorkspacePath,
  journalPath,
  normalizeWriteMode,
  parseJournal,
  preparedJournal,
  recoverDeleteJournal,
  recoverMoveJournal,
  recoverWriteJournal,
  siblingPath,
  targetWriteMode,
  validateJournalPaths
};