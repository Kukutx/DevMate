import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024;
const STALE_JOURNAL_TEMP_MS = 24 * 60 * 60 * 1000;

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

function realDirectoryInside(workspaceRoot, directory) {
  const root = fs.realpathSync.native(path.resolve(workspaceRoot));
  const current = fs.realpathSync.native(path.resolve(directory));
  if (!isInside(root, current)) {
    const error = new Error(`File transaction path escapes workspace root: ${directory}`);
    error.code = 'FILE_TRANSACTION_PATH_ESCAPE';
    throw error;
  }
  return current;
}

function assertWorkspacePath(workspaceRoot, target) {
  const root = path.resolve(workspaceRoot);
  const full = path.resolve(target);
  if (!isInside(root, full) || full === root) {
    const error = new Error(`File transaction path is outside the workspace: ${target}`);
    error.code = 'FILE_TRANSACTION_PATH_ESCAPE';
    throw error;
  }
  realDirectoryInside(root, path.dirname(full));
  return full;
}

function transactionError(message, code, journal = null, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (journal) {
    error.transactionId = journal.id;
    error.journalFile = journal.journalFile || null;
  }
  if (cause) error.cause = cause;
  return error;
}

function transactionId() {
  return `ftx-${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
}

function siblingPath(target, id, purpose) {
  const base = path.basename(target);
  return path.join(path.dirname(target), `.${base}.devmate-${purpose}-${id}`);
}

function journalPath(transactionRoot, id) {
  return path.join(path.resolve(transactionRoot), `${id}.json`);
}

function writeNewJournal(transactionRoot, document) {
  const root = path.resolve(transactionRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch {}
  const file = journalPath(root, document.id);
  const payload = `${JSON.stringify({ ...document, journalFile: undefined }, null, 2)}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_JOURNAL_BYTES) throw transactionError('File transaction journal exceeds its size bound', 'FILE_TRANSACTION_JOURNAL_TOO_LARGE', document);
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
  if (!stat?.isFile() || stat.size > MAX_JOURNAL_BYTES) throw transactionError(`Invalid file transaction journal: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (cause) { throw transactionError(`Invalid file transaction journal JSON: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID', null, cause); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== JOURNAL_VERSION) {
    throw transactionError(`Unsupported file transaction journal: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID');
  }
  if (!['write-file', 'move-replace'].includes(value.kind) || !String(value.id || '').startsWith('ftx-')) {
    throw transactionError(`Invalid file transaction journal shape: ${file}`, 'FILE_TRANSACTION_JOURNAL_INVALID');
  }
  return { ...value, journalFile: file };
}

function validateJournalPaths(journal, allowedWorkspaceRoots) {
  const allowed = new Set((allowedWorkspaceRoots || []).map(pathKey));
  const workspaceRoot = path.resolve(String(journal.workspaceRoot || ''));
  if (!allowed.has(pathKey(workspaceRoot))) {
    throw transactionError(`File transaction references an inactive workspace: ${workspaceRoot}`, 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
  }
  const target = assertWorkspacePath(workspaceRoot, journal.target);
  const expectedRollback = siblingPath(target, journal.id, 'rollback');
  if (path.resolve(journal.rollback) !== path.resolve(expectedRollback)) {
    throw transactionError('File transaction rollback path does not match its target', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
  }
  let source = null;
  let temporary = null;
  if (journal.kind === 'move-replace') {
    source = assertWorkspacePath(workspaceRoot, journal.source);
  } else {
    temporary = assertWorkspacePath(workspaceRoot, journal.temporary);
    const expectedTemporary = siblingPath(target, journal.id, 'write');
    if (path.resolve(temporary) !== path.resolve(expectedTemporary)) {
      throw transactionError('File transaction temporary path does not match its target', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
    }
  }
  return { workspaceRoot, target, source, temporary, rollback: path.resolve(journal.rollback) };
}

async function removeIfPresent(file, options = {}) {
  if (!file || !fs.existsSync(file)) return true;
  try {
    await fsp.rm(file, { recursive: options.recursive === true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function recoverWriteJournal(journal, paths) {
  const targetExists = fs.existsSync(paths.target);
  const rollbackExists = fs.existsSync(paths.rollback);
  const temporaryExists = fs.existsSync(paths.temporary);

  if (rollbackExists) {
    if (targetExists) {
      if (!(await removeIfPresent(paths.rollback, { recursive: false }))) {
        throw transactionError('Committed file replacement still has an undeletable rollback file', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
      }
      await removeIfPresent(paths.temporary);
      removeJournal(journal);
      return { id: journal.id, action: 'finish-committed-write' };
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

  if (journal.targetExisted === false && temporaryExists) {
    await removeIfPresent(paths.temporary);
    removeJournal(journal);
    return { id: journal.id, action: 'discard-uncommitted-create' };
  }

  throw transactionError('Interrupted file replacement has an ambiguous filesystem state', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal);
}

async function recoverMoveJournal(journal, paths) {
  const sourceExists = fs.existsSync(paths.source);
  const targetExists = fs.existsSync(paths.target);
  const rollbackExists = fs.existsSync(paths.rollback);

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

export async function recoverFileTransactions({ transactionRoot, workspaceRoots = [] } = {}) {
  const root = path.resolve(String(transactionRoot || ''));
  if (!transactionRoot) throw new Error('transactionRoot is required');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  let entries = await fsp.readdir(root, { withFileTypes: true });
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
    const file = path.join(root, entry.name);
    const stat = await fsp.stat(file).catch(() => null);
    if (stat && now - stat.mtimeMs > STALE_JOURNAL_TEMP_MS) await fsp.rm(file, { force: true }).catch(() => {});
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
      recovered.push(journal.kind === 'write-file'
        ? await recoverWriteJournal(journal, paths)
        : await recoverMoveJournal(journal, paths));
    } catch (error) {
      blocked.push({ file, code: String(error?.code || 'FILE_TRANSACTION_RECOVERY_BLOCKED'), message: String(error?.message || error) });
    }
  }
  return { recovered, blocked };
}

function preparedJournal({ kind, transactionRoot, workspaceRoot, target, source = null, targetExisted = null }) {
  const id = transactionId();
  const cleanTarget = assertWorkspacePath(workspaceRoot, target);
  const journal = {
    version: JOURNAL_VERSION,
    id,
    kind,
    workspaceRoot: path.resolve(workspaceRoot),
    source: source ? assertWorkspacePath(workspaceRoot, source) : null,
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

async function writeTempFile(journal, writer) {
  let handle = null;
  try {
    handle = await fsp.open(journal.temporary, 'wx', 0o600);
    await writer(handle);
    try { await handle.sync(); } catch {}
    await handle.close();
    handle = null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function finalizeJournal(journal) {
  const rollbackPending = fs.existsSync(journal.rollback);
  if (rollbackPending && !(await removeIfPresent(journal.rollback, { recursive: true }))) {
    return { transactionId: journal.id, cleanupPending: true, journalFile: journal.journalFile };
  }
  removeJournal(journal);
  return { transactionId: journal.id, cleanupPending: false, journalFile: null };
}

async function commitPreparedWrite(journal) {
  try {
    await fsp.rename(journal.temporary, journal.target);
    fsyncDirectory(path.dirname(journal.target));
    return finalizeJournal(journal);
  } catch (directError) {
    if (!journal.targetExisted || !fs.existsSync(journal.target)) throw directError;
    try {
      await fsp.rename(journal.target, journal.rollback);
      fsyncDirectory(path.dirname(journal.target));
      await fsp.rename(journal.temporary, journal.target);
      fsyncDirectory(path.dirname(journal.target));
    } catch (cause) {
      if (!fs.existsSync(journal.target) && fs.existsSync(journal.rollback)) {
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

export async function atomicWriteText({ transactionRoot, workspaceRoot, target, content, encoding = 'utf8' } = {}) {
  const targetExisted = fs.existsSync(target);
  const journal = preparedJournal({ kind: 'write-file', transactionRoot, workspaceRoot, target, targetExisted });
  try {
    await fsp.mkdir(path.dirname(journal.target), { recursive: true });
    await writeTempFile(journal, handle => handle.writeFile(String(content ?? ''), { encoding }));
    return await commitPreparedWrite(journal);
  } catch (error) {
    if (error?.code === 'FILE_TRANSACTION_RECOVERY_BLOCKED') throw error;
    const recovery = await recoverFileTransactions({ transactionRoot, workspaceRoots: [workspaceRoot] });
    if (recovery.blocked.some(item => item.file === journal.journalFile)) {
      throw transactionError('File write failed and recovery requires manual intervention', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, error);
    }
    throw error;
  }
}

export async function atomicCopyFile({ transactionRoot, workspaceRoot, source, target } = {}) {
  const targetExisted = fs.existsSync(target);
  const journal = preparedJournal({ kind: 'write-file', transactionRoot, workspaceRoot, target, targetExisted });
  try {
    await fsp.mkdir(path.dirname(journal.target), { recursive: true });
    await writeTempFile(journal, async handle => {
      const input = await fsp.open(path.resolve(source), 'r');
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          await handle.write(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
      } finally {
        await input.close();
      }
    });
    return await commitPreparedWrite(journal);
  } catch (error) {
    if (error?.code === 'FILE_TRANSACTION_RECOVERY_BLOCKED') throw error;
    const recovery = await recoverFileTransactions({ transactionRoot, workspaceRoots: [workspaceRoot] });
    if (recovery.blocked.some(item => item.file === journal.journalFile)) {
      throw transactionError('File restore failed and recovery requires manual intervention', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, error);
    }
    throw error;
  }
}

export async function transactionalMove({ transactionRoot, workspaceRoot, source, target, overwrite = false } = {}) {
  const cleanSource = assertWorkspacePath(workspaceRoot, source);
  const cleanTarget = assertWorkspacePath(workspaceRoot, target);
  if (pathKey(cleanSource) === pathKey(cleanTarget)) return { transactionId: null, cleanupPending: false, noOp: true };
  const targetExists = fs.existsSync(cleanTarget);
  if (targetExists && !overwrite) throw new Error('Destination exists; pass overwrite=true');
  await fsp.mkdir(path.dirname(cleanTarget), { recursive: true });
  if (!targetExists) {
    await fsp.rename(cleanSource, cleanTarget);
    fsyncDirectory(path.dirname(cleanSource));
    if (path.dirname(cleanSource) !== path.dirname(cleanTarget)) fsyncDirectory(path.dirname(cleanTarget));
    return { transactionId: null, cleanupPending: false, noOp: false };
  }

  try {
    const sourceStat = await fsp.stat(cleanSource);
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
  } catch {
  }

  const journal = preparedJournal({ kind: 'move-replace', transactionRoot, workspaceRoot, source: cleanSource, target: cleanTarget, targetExisted: true });
  try {
    await fsp.rename(cleanTarget, journal.rollback);
    fsyncDirectory(path.dirname(cleanTarget));
    try {
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
    return finalizeJournal(journal);
  } catch (error) {
    if (error?.code === 'FILE_TRANSACTION_RECOVERY_BLOCKED') throw error;
    const recovery = await recoverFileTransactions({ transactionRoot, workspaceRoots: [workspaceRoot] });
    if (recovery.blocked.some(item => item.file === journal.journalFile)) {
      throw transactionError('Move failed and recovery requires manual intervention', 'FILE_TRANSACTION_RECOVERY_BLOCKED', journal, error);
    }
    throw error;
  }
}

export const __test = {
  JOURNAL_VERSION,
  MAX_JOURNAL_BYTES,
  STALE_JOURNAL_TEMP_MS,
  assertWorkspacePath,
  journalPath,
  parseJournal,
  preparedJournal,
  recoverMoveJournal,
  recoverWriteJournal,
  siblingPath,
  validateJournalPaths
};
