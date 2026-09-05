import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requestWorkSessionId } from './request-context.mjs';
import { workSession } from './work-sessions.mjs';
import { isSensitiveWorkspacePath, sensitiveWorkspacePathReason } from './sensitive-path-policy.mjs';

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_INDEX_VERSION = 1;
export const BACKUP_MANIFEST_FILE = 'manifest.json';
export const BACKUP_OPERATION_FILE = 'operation.json';
export const BACKUP_INDEX_FILE = 'index.jsonl';
export const BACKUP_PENDING_PREFIX = '.pending-';
export const MAX_BACKUP_MANIFEST_BYTES = 128 * 1024;
export const MAX_BACKUP_INDEX_BYTES = 64 * 1024 * 1024;
export const BACKUP_INDEX_COMPACT_BYTES = 48 * 1024 * 1024;
export const MAX_BACKUP_ENTRIES = 4;
export const MAX_BACKUP_SETS = 20_000;
export const MAX_BACKUP_TREE_ENTRIES = 20_000;
export const MAX_BACKUP_PATH_CHARS = 4096;
export const WORK_SESSION_BACKUP_GRACE_MS = 24 * 60 * 60 * 1000;

const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
export const BACKUP_ROOT = CONFIG_PATH ? path.join(path.dirname(path.resolve(CONFIG_PATH)), 'state', 'backups') : '';
const BACKUP_ID = /^bkp-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-[a-f0-9]{8}$/;

let catalog = null;
let catalogEventCount = 0;
let catalogTail = Promise.resolve();
let snapshotTail = Promise.resolve();

function normalizeSlash(value) {
  return String(value || '').replace(/\\/g, '/');
}

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function relativeKey(value) {
  const normalized = normalizeSlash(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requiredRoot() {
  if (!BACKUP_ROOT) throw new Error('DEVMATE_CONFIG is required for automatic backups');
  return BACKUP_ROOT;
}

function existingAncestor(target) {
  let current = path.resolve(target);
  while (!fs.lstatSync(current, { throwIfNoEntry: false }) && current !== path.dirname(current)) {
    current = path.dirname(current);
  }
  return current;
}

function canonicalWorkspaceRoot(root) {
  const resolved = path.resolve(String(root || ''));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`Backup workspace root is unavailable: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

export function workspaceRootFingerprint(root) {
  return crypto.createHash('sha256').update(pathKey(canonicalWorkspaceRoot(root))).digest('hex');
}

function backupId() {
  return `bkp-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
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

async function syncFile(file) {
  let handle = null;
  try {
    handle = await fsp.open(file, 'r');
    await handle.sync();
  } catch {
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function atomicWriteBackupJson(file, value) {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_BACKUP_MANIFEST_BYTES) {
    throw new Error(`Backup metadata exceeds ${MAX_BACKUP_MANIFEST_BYTES} bytes`);
  }
  const temporary = `${file}.${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    try { await handle.sync(); } catch {}
    await handle.close();
    handle = null;
    await fsp.rename(temporary, file);
    try { await fsp.chmod(file, 0o600); } catch {}
    fsyncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function normalizedEntryPath(value) {
  const rel = normalizeSlash(String(value || '').trim());
  if (rel.length > MAX_BACKUP_PATH_CHARS) {
    throw new Error(`Backup entry path exceeds ${MAX_BACKUP_PATH_CHARS} characters`);
  }
  if (!rel || rel === '.' || rel.startsWith('/') || /^[a-z]:\//i.test(rel)) {
    throw new Error(`Backup entry path must be workspace-relative: ${value}`);
  }
  const normalized = path.posix.normalize(rel);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Backup entry path escapes workspace: ${value}`);
  }
  return normalized;
}

function assertBackupOriginalPath(value) {
  const rel = normalizedEntryPath(value);
  if (isSensitiveWorkspacePath(rel)) {
    const error = new Error(`Automatic backup blocked for protected path: ${rel}`);
    error.code = 'sensitive_workspace_path';
    error.reason = sensitiveWorkspacePathReason(rel);
    throw error;
  }
  return rel;
}

function workspaceRelativeSource(root, source) {
  const rootResolved = path.resolve(String(root || ''));
  const rootReal = canonicalWorkspaceRoot(rootResolved);
  const full = path.resolve(String(source || ''));
  if (!isInside(rootResolved, full) || pathKey(rootResolved) === pathKey(full)) {
    const error = new Error(`Automatic backup source is outside workspace: ${source}`);
    error.code = 'backup_source_outside_workspace';
    throw error;
  }
  const direct = fs.lstatSync(full, { throwIfNoEntry: false });
  let resolvedReal;
  if (direct) {
    if (direct.isSymbolicLink()) {
      const error = new Error(`Automatic backup refuses symlink/reparse source: ${source}`);
      error.code = 'backup_source_symlink';
      throw error;
    }
    resolvedReal = fs.realpathSync.native(full);
  } else {
    const ancestor = existingAncestor(path.dirname(full));
    const ancestorReal = fs.realpathSync.native(ancestor);
    resolvedReal = path.resolve(ancestorReal, path.relative(ancestor, full));
  }
  if (!isInside(rootReal, resolvedReal) || pathKey(rootReal) === pathKey(resolvedReal)) {
    const error = new Error(`Automatic backup source escapes workspace through a symlink/reparse point: ${source}`);
    error.code = 'backup_source_outside_workspace';
    throw error;
  }
  return normalizeSlash(path.relative(rootReal, resolvedReal));
}

function assertEntrySourceMapping(workspace, originalPath, sourcePath) {
  if (!sourcePath) return;
  const actual = workspaceRelativeSource(workspace.root, sourcePath);
  if (relativeKey(actual) !== relativeKey(originalPath)) {
    const error = new Error(`Automatic backup source does not match original path: ${originalPath}`);
    error.code = 'backup_source_path_mismatch';
    throw error;
  }
}

function consumeTreeEntry(budget, code, message) {
  budget.entries += 1;
  if (budget.entries > budget.maxEntries) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

async function snapshotDescriptor(source, destination, budget, originalPath) {
  const safeOriginalPath = assertBackupOriginalPath(originalPath);
  consumeTreeEntry(
    budget,
    'backup_snapshot_entry_limit',
    `Automatic backup snapshot exceeds ${budget.maxEntries} filesystem entries`
  );
  const stat = await fsp.lstat(source);
  if (stat.isSymbolicLink()) {
    const error = new Error(`Automatic backup refuses symlink/reparse source: ${source}`);
    error.code = 'backup_source_symlink';
    throw error;
  }
  if (stat.isFile()) {
    budget.bytes += stat.size;
    budget.files += 1;
    if (budget.bytes > budget.maxBytes) {
      const error = new Error(`Automatic backup snapshot exceeds the configured ${budget.maxBytes} byte retention budget`);
      error.code = 'backup_snapshot_too_large';
      throw error;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    try { await fsp.chmod(destination, stat.mode & 0o777); } catch {}
    await syncFile(destination);
    fsyncDirectory(path.dirname(destination));
    return {
      kind: 'file',
      sizeBytes: stat.size,
      fileCount: 1,
      sha256: await hashFile(destination),
      mode: stat.mode & 0o777
    };
  }
  if (!stat.isDirectory()) {
    const error = new Error('Unsupported automatic backup target type');
    error.code = 'backup_source_type_unsupported';
    throw error;
  }
  await fsp.mkdir(destination, { recursive: false, mode: stat.mode & 0o777 });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let files = 0;
  const entries = await fsp.readdir(source, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childOriginalPath = normalizeSlash(path.posix.join(safeOriginalPath, entry.name));
    const child = await snapshotDescriptor(
      path.join(source, entry.name),
      path.join(destination, entry.name),
      budget,
      childOriginalPath
    );
    bytes += child.sizeBytes;
    files += child.fileCount;
    hash.update(`${entry.name}\0${child.kind}\0${child.sizeBytes}\0${child.sha256}\n`);
  }
  fsyncDirectory(destination);
  fsyncDirectory(path.dirname(destination));
  return {
    kind: 'directory',
    sizeBytes: bytes,
    fileCount: files,
    sha256: hash.digest('hex'),
    mode: stat.mode & 0o777
  };
}

async function describePayload(
  target,
  budget = { entries: 0, maxEntries: MAX_BACKUP_TREE_ENTRIES },
  originalPath = '__backup_payload__'
) {
  const safeOriginalPath = assertBackupOriginalPath(originalPath);
  consumeTreeEntry(
    budget,
    'backup_integrity_scan_limit',
    `Backup payload integrity scan exceeds ${budget.maxEntries} filesystem entries`
  );
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) {
    const error = new Error('Backup payload contains a symlink/reparse point');
    error.code = 'backup_integrity_symlink';
    throw error;
  }
  if (stat.isFile()) {
    return {
      kind: 'file',
      sizeBytes: stat.size,
      fileCount: 1,
      sha256: await hashFile(target),
      mode: stat.mode & 0o777
    };
  }
  if (!stat.isDirectory()) {
    const error = new Error('Backup payload has unsupported type');
    error.code = 'backup_integrity_type_invalid';
    throw error;
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let files = 0;
  const entries = await fsp.readdir(target, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childOriginalPath = normalizeSlash(path.posix.join(safeOriginalPath, entry.name));
    const child = await describePayload(
      path.join(target, entry.name),
      budget,
      childOriginalPath
    );
    bytes += child.sizeBytes;
    files += child.fileCount;
    hash.update(`${entry.name}\0${child.kind}\0${child.sizeBytes}\0${child.sha256}\n`);
  }
  return {
    kind: 'directory',
    sizeBytes: bytes,
    fileCount: files,
    sha256: hash.digest('hex'),
    mode: stat.mode & 0o777
  };
}

function validManifest(value, id = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== BACKUP_FORMAT_VERSION) return false;
  if (!BACKUP_ID.test(String(value.id || '')) || (id && value.id !== id)) return false;
  if (!Number.isFinite(Date.parse(value.createdAt || ''))) return false;
  if (!String(value.action || '').trim() || String(value.action).length > 100) return false;
  if (!value.workspace || typeof value.workspace !== 'object' || !String(value.workspace.id || '').trim()) return false;
  if (!/^[a-f0-9]{64}$/.test(String(value.workspace.rootFingerprint || ''))) return false;
  if (value.retainUntil != null && !Number.isFinite(Date.parse(value.retainUntil))) return false;
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0) return false;
  if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 0) return false;
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_BACKUP_ENTRIES) return false;
  const payloads = new Set();
  let totalBytes = 0;
  let totalFiles = 0;
  for (const entry of value.entries) {
    if (!entry || typeof entry !== 'object') return false;
    if (!String(entry.role || '').trim()) return false;
    try { assertBackupOriginalPath(entry.originalPath); } catch { return false; }
    if (!['absent', 'file', 'directory'].includes(entry.kind)) return false;
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) return false;
    if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount < 0) return false;
    if (entry.kind === 'absent') {
      if (entry.payload != null || entry.sha256 != null || entry.sizeBytes !== 0 || entry.fileCount !== 0) return false;
    } else {
      const payload = normalizeSlash(String(entry.payload || ''));
      if (!/^payload\/\d+$/.test(payload) || payloads.has(payload)) return false;
      payloads.add(payload);
      if (!/^[a-f0-9]{64}$/.test(String(entry.sha256 || ''))) return false;
    }
    if (entry.mode != null && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)) return false;
    totalBytes += entry.sizeBytes;
    totalFiles += entry.fileCount;
  }
  return totalBytes === value.totalBytes && totalFiles === value.fileCount;
}

function validOperation(value, id) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== BACKUP_FORMAT_VERSION) return false;
  if (value.backupId !== id || !Number.isFinite(Date.parse(value.committedAt || ''))) return false;
  const completed = value.mutationCompletedAt == null ? null : Date.parse(value.mutationCompletedAt);
  const failed = value.mutationFailedAt == null ? null : Date.parse(value.mutationFailedAt);
  if (value.mutationCompletedAt != null && !Number.isFinite(completed)) return false;
  if (value.mutationFailedAt != null && !Number.isFinite(failed)) return false;
  if (value.mutationCompletedAt != null && value.mutationFailedAt != null) return false;
  if (value.transactionId != null && typeof value.transactionId !== 'string') return false;
  if (value.mutationErrorCode != null && typeof value.mutationErrorCode !== 'string') return false;
  return true;
}

async function readJsonBounded(file, maxBytes) {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > maxBytes) return null;
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

async function readSet(id) {
  if (!BACKUP_ID.test(String(id || ''))) {
    const error = new Error(`Invalid backupId: ${id}`);
    error.code = 'backup_id_invalid';
    throw error;
  }
  const root = requiredRoot();
  const setRoot = path.join(root, id);
  if (!isInside(root, setRoot)) throw new Error('Backup set escapes automatic backup root');
  const manifest = await readJsonBounded(path.join(setRoot, BACKUP_MANIFEST_FILE), MAX_BACKUP_MANIFEST_BYTES);
  if (!validManifest(manifest, id)) {
    const error = new Error(`Backup manifest is invalid or unavailable: ${id}`);
    error.code = 'backup_manifest_invalid';
    throw error;
  }
  const operation = await readJsonBounded(path.join(setRoot, BACKUP_OPERATION_FILE), MAX_BACKUP_MANIFEST_BYTES);
  const committed = validOperation(operation, id);
  return { setRoot, manifest, operation: committed ? operation : null, committed };
}

function summaryFor(manifest, operation = null) {
  const mutationState = !operation
    ? 'uncommitted'
    : operation.mutationFailedAt
      ? 'failed'
      : operation.mutationCompletedAt
        ? 'completed'
        : 'prepared';
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    committedAt: operation?.committedAt || null,
    mutationCompletedAt: operation?.mutationCompletedAt || null,
    mutationFailedAt: operation?.mutationFailedAt || null,
    mutationErrorCode: operation?.mutationErrorCode || null,
    mutationState,
    transactionId: operation?.transactionId || null,
    committed: !!operation,
    action: String(manifest.action || ''),
    workspaceId: manifest.workspace.id,
    workspaceName: String(manifest.workspace.name || manifest.workspace.id),
    workSessionId: manifest.workSessionId || null,
    workSessionPrincipalId: manifest.workSessionPrincipalId || null,
    workSessionPrincipalName: manifest.workSessionPrincipalName || null,
    retainUntil: manifest.retainUntil || null,
    totalBytes: Number(manifest.totalBytes || 0),
    fileCount: Number(manifest.fileCount || 0),
    entries: manifest.entries.map(entry => ({
      role: entry.role,
      originalPath: entry.originalPath,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      fileCount: entry.fileCount,
      sha256: entry.sha256 || null
    }))
  };
}

function validSummaryRecord(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (!BACKUP_ID.test(String(item.id || '')) || item.committed !== true) return false;
  if (!Number.isFinite(Date.parse(item.createdAt || '')) || !Number.isFinite(Date.parse(item.committedAt || ''))) return false;
  if (!String(item.workspaceId || '').trim() || !String(item.action || '').trim()) return false;
  if (!['prepared', 'completed', 'failed'].includes(item.mutationState)) return false;
  if (item.mutationState === 'prepared' && (item.mutationCompletedAt != null || item.mutationFailedAt != null)) return false;
  if (item.mutationState === 'completed' && !Number.isFinite(Date.parse(item.mutationCompletedAt || ''))) return false;
  if (item.mutationState === 'failed' && !Number.isFinite(Date.parse(item.mutationFailedAt || ''))) return false;
  if (!Number.isSafeInteger(item.totalBytes) || item.totalBytes < 0) return false;
  if (!Number.isSafeInteger(item.fileCount) || item.fileCount < 0) return false;
  if (!Array.isArray(item.entries) || item.entries.length < 1 || item.entries.length > MAX_BACKUP_ENTRIES) return false;
  for (const entry of item.entries) {
    if (!entry || typeof entry !== 'object') return false;
    try { normalizedEntryPath(entry.originalPath); } catch { return false; }
    if (!['absent', 'file', 'directory'].includes(entry.kind)) return false;
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) return false;
    if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount < 0) return false;
  }
  return true;
}

function indexHeader() {
  return { version: BACKUP_INDEX_VERSION, type: 'header' };
}

function indexUpsert(record) {
  return { version: BACKUP_INDEX_VERSION, type: 'upsert', record };
}

function indexDelete(id) {
  return { version: BACKUP_INDEX_VERSION, type: 'delete', id };
}

async function compactIndex(records = catalog || []) {
  if (!BACKUP_ROOT) return;
  const file = path.join(BACKUP_ROOT, BACKUP_INDEX_FILE);
  const lines = [indexHeader(), ...records.map(indexUpsert)].map(value => JSON.stringify(value));
  const payload = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > MAX_BACKUP_INDEX_BYTES) {
    const error = new Error(`Backup index exceeds ${MAX_BACKUP_INDEX_BYTES} bytes`);
    error.code = 'backup_index_too_large';
    throw error;
  }
  await fsp.mkdir(BACKUP_ROOT, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}-${crypto.randomBytes(5).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await fsp.open(temporary, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    try { await handle.sync(); } catch {}
    await handle.close();
    handle = null;
    await fsp.rename(temporary, file);
    try { await fsp.chmod(file, 0o600); } catch {}
    fsyncDirectory(BACKUP_ROOT);
    catalogEventCount = records.length;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function persistIndexEvents(events, recordsAfter = catalog || []) {
  if (!events.length) return;
  const file = path.join(requiredRoot(), BACKUP_INDEX_FILE);
  const stat = await fsp.stat(file).catch(() => null);
  const payload = `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
  const projected = Number(stat?.size || 0) + Buffer.byteLength(payload, 'utf8');
  const eventLimit = Math.max(1000, recordsAfter.length * 4 + 1000);
  if (
    !stat?.isFile() ||
    projected > BACKUP_INDEX_COMPACT_BYTES ||
    projected > MAX_BACKUP_INDEX_BYTES ||
    catalogEventCount + events.length > eventLimit
  ) {
    await compactIndex(recordsAfter);
    return;
  }
  let handle = null;
  try {
    handle = await fsp.open(file, 'a', 0o600);
    await handle.writeFile(payload, 'utf8');
    try { await handle.sync(); } catch {}
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  try { await fsp.chmod(file, 0o600); } catch {}
  catalogEventCount += events.length;
}

async function scanCatalog({ purgeLegacy = false } = {}) {
  const root = requiredRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const records = [];
  const removed = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.name === BACKUP_INDEX_FILE) continue;
    if (entry.name.startsWith(BACKUP_PENDING_PREFIX)) {
      if (purgeLegacy) {
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push({ name: entry.name, reason: 'pending' });
      }
      continue;
    }
    if (!entry.isDirectory() || !BACKUP_ID.test(entry.name)) {
      if (purgeLegacy) {
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push({ name: entry.name, reason: 'legacy' });
      }
      continue;
    }
    try {
      const set = await readSet(entry.name);
      if (!set.committed) {
        if (purgeLegacy) {
          await fsp.rm(full, { recursive: true, force: true });
          removed.push({ name: entry.name, reason: 'uncommitted' });
        }
        continue;
      }
      records.push(summaryFor(set.manifest, set.operation));
    } catch {
      if (purgeLegacy) {
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push({ name: entry.name, reason: 'invalid' });
      }
    }
  }
  records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
  catalog = records;
  await compactIndex(records);
  return { records, removed };
}

async function loadIndex() {
  if (!BACKUP_ROOT) return null;
  const file = path.join(BACKUP_ROOT, BACKUP_INDEX_FILE);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_BACKUP_INDEX_BYTES) return null;
  let lines = [];
  try {
    lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
  if (!lines.length) return null;
  let header;
  try { header = JSON.parse(lines[0]); } catch { return null; }
  if (!header || header.version !== BACKUP_INDEX_VERSION || header.type !== 'header') return null;
  const records = new Map();
  let eventCount = 0;
  for (const line of lines.slice(1)) {
    let event;
    try { event = JSON.parse(line); } catch { return null; }
    if (!event || event.version !== BACKUP_INDEX_VERSION) return null;
    if (event.type === 'upsert') {
      if (!validSummaryRecord(event.record)) return null;
      records.set(event.record.id, event.record);
    } else if (event.type === 'delete') {
      if (!BACKUP_ID.test(String(event.id || ''))) return null;
      records.delete(event.id);
    } else {
      return null;
    }
    eventCount += 1;
  }
  const values = [...records.values()].sort(
    (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id)
  );
  return { records: values, eventCount };
}

async function ensureCatalog() {
  if (catalog) return catalog;
  const index = await loadIndex();
  if (index) {
    catalog = index.records;
    catalogEventCount = index.eventCount;
    return catalog;
  }
  return (await scanCatalog()).records;
}

function serializeCatalog(operation) {
  const task = catalogTail.then(operation, operation);
  catalogTail = task.then(() => undefined, () => undefined);
  return task;
}

function serializeSnapshots(operation) {
  const task = snapshotTail.then(operation, operation);
  snapshotTail = task.then(() => undefined, () => undefined);
  return task;
}

function currentSessionMetadata() {
  const id = requestWorkSessionId();
  if (!id) {
    return {
      workSessionId: null,
      workSessionPrincipalId: null,
      workSessionPrincipalName: null,
      retainUntil: null
    };
  }
  const session = workSession(id);
  const graceUntil = Date.now() + WORK_SESSION_BACKUP_GRACE_MS;
  const sessionUntil = Number.isFinite(Date.parse(session?.expiresAt || '')) ? Date.parse(session.expiresAt) : 0;
  return {
    workSessionId: id,
    workSessionPrincipalId: session?.principalId || null,
    workSessionPrincipalName: session?.principalName || null,
    retainUntil: new Date(Math.max(graceUntil, sessionUntil)).toISOString()
  };
}

function newestIdsPerWorkspace(records) {
  const seen = new Set();
  const ids = new Set();
  for (const item of [...records]
    .filter(item => item.committed && item.mutationState !== 'failed')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    if (seen.has(item.workspaceId)) continue;
    seen.add(item.workspaceId);
    ids.add(item.id);
  }
  return ids;
}

function fairVictim(records, nowMs) {
  const newest = newestIdsPerWorkspace(records);
  const totals = new Map();
  for (const item of records) {
    totals.set(item.workspaceId, (totals.get(item.workspaceId) || 0) + Number(item.totalBytes || 0));
  }
  const candidates = records.filter(item => {
    if (newest.has(item.id)) return false;
    if (item.mutationState === 'prepared') return false;
    return !(Number.isFinite(Date.parse(item.retainUntil || '')) && Date.parse(item.retainUntil) > nowMs);
  });
  candidates.sort((a, b) =>
    (totals.get(b.workspaceId) || 0) - (totals.get(a.workspaceId) || 0) ||
    String(a.createdAt).localeCompare(String(b.createdAt))
  );
  return candidates[0] || null;
}

async function removeCommittedSet(id) {
  const root = requiredRoot();
  const setRoot = path.join(root, id);
  if (!BACKUP_ID.test(id) || !isInside(root, setRoot)) {
    throw new Error(`Refusing to remove invalid backup set: ${id}`);
  }
  await fsp.rm(setRoot, { recursive: true, force: true });
}

export async function pruneBackupStore({
  backupRetentionDays = 30,
  maxBackupBytes = 512 * 1024 * 1024,
  additionalBytes = 0,
  additionalSets = 0,
  nowMs = Date.now()
} = {}) {
  return serializeCatalog(async () => {
    const records = [...await ensureCatalog()];
    const cutoff = nowMs - Math.max(1, Number(backupRetentionDays) || 30) * 24 * 60 * 60 * 1000;
    const deleted = [];
    let kept = [];
    for (const item of records) {
      const protectedSnapshot =
        item.mutationState === 'prepared' ||
        (Number.isFinite(Date.parse(item.retainUntil || '')) && Date.parse(item.retainUntil) > nowMs);
      if (!protectedSnapshot && Date.parse(item.createdAt) < cutoff) {
        deleted.push({ ...item, reason: 'age' });
      } else {
        kept.push(item);
      }
    }
    while (kept.length + Math.max(0, Number(additionalSets) || 0) > MAX_BACKUP_SETS) {
      const victim = fairVictim(kept, nowMs);
      if (!victim) {
        const error = new Error('Automatic backup count is exhausted by protected/latest snapshots; mutation was refused before changing files');
        error.code = 'backup_capacity_exhausted';
        throw error;
      }
      kept = kept.filter(item => item.id !== victim.id);
      deleted.push({ ...victim, reason: 'count-fair' });
    }
    let total = kept.reduce((sum, item) => sum + Number(item.totalBytes || 0), 0);
    const maxBytes = Math.max(1024 * 1024, Number(maxBackupBytes) || 512 * 1024 * 1024);
    while (total + additionalBytes > maxBytes) {
      const victim = fairVictim(kept, nowMs);
      if (!victim) {
        const error = new Error('Automatic backup capacity is exhausted by protected/latest snapshots; mutation was refused before changing files');
        error.code = 'backup_capacity_exhausted';
        throw error;
      }
      kept = kept.filter(item => item.id !== victim.id);
      total -= Number(victim.totalBytes || 0);
      deleted.push({ ...victim, reason: 'size-fair' });
    }
    for (const item of deleted) await removeCommittedSet(item.id);
    const next = kept.sort(
      (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id)
    );
    if (deleted.length) {
      try {
        await persistIndexEvents(deleted.map(item => indexDelete(item.id)), next);
      } finally {
        catalog = next;
      }
    } else {
      catalog = next;
    }
    return {
      beforeSets: records.length,
      afterSets: next.length,
      beforeBytes: records.reduce((sum, item) => sum + Number(item.totalBytes || 0), 0),
      afterBytes: total,
      deleted: deleted.map(item => ({
        id: item.id,
        reason: item.reason,
        totalBytes: item.totalBytes,
        workspaceId: item.workspaceId
      }))
    };
  });
}

async function createBackupSnapshotInternal({
  workspace,
  action,
  entries,
  backupRetentionDays = 30,
  maxBackupBytes = 512 * 1024 * 1024,
  attachWorkSession = true
} = {}) {
  requiredRoot();
  if (!workspace?.id || !workspace?.root) {
    throw new Error('A writable workspace is required for automatic backup');
  }
  canonicalWorkspaceRoot(workspace.root);
  const requested = Array.isArray(entries) ? entries : [];
  if (requested.length < 1 || requested.length > MAX_BACKUP_ENTRIES) {
    throw new Error(`Automatic backup requires 1-${MAX_BACKUP_ENTRIES} snapshot entries`);
  }
  const id = backupId();
  const pending = path.join(BACKUP_ROOT, `${BACKUP_PENDING_PREFIX}${id}`);
  const finalRoot = path.join(BACKUP_ROOT, id);
  const budget = {
    bytes: 0,
    files: 0,
    entries: 0,
    maxEntries: MAX_BACKUP_TREE_ENTRIES,
    maxBytes: Math.max(1024 * 1024, Number(maxBackupBytes) || 512 * 1024 * 1024)
  };
  const session = attachWorkSession
    ? currentSessionMetadata()
    : {
        workSessionId: null,
        workSessionPrincipalId: null,
        workSessionPrincipalName: null,
        retainUntil: null
      };
  await fsp.mkdir(path.join(pending, 'payload'), { recursive: true, mode: 0o700 });
  let finalPublished = false;
  try {
    const snapshotEntries = [];
    for (let index = 0; index < requested.length; index += 1) {
      const input = requested[index] || {};
      const originalPath = assertBackupOriginalPath(input.originalPath);
      const sourcePath = input.sourcePath ? path.resolve(String(input.sourcePath)) : '';
      if (sourcePath) assertEntrySourceMapping(workspace, originalPath, sourcePath);
      if (!sourcePath || !fs.lstatSync(sourcePath, { throwIfNoEntry: false })) {
        snapshotEntries.push({
          role: String(input.role || `entry-${index}`),
          originalPath,
          kind: 'absent',
          payload: null,
          sizeBytes: 0,
          fileCount: 0,
          sha256: null,
          mode: null
        });
        continue;
      }
      const payload = normalizeSlash(path.join('payload', String(index)));
      const descriptor = await snapshotDescriptor(
        sourcePath,
        path.join(pending, payload),
        budget,
        originalPath
      );
      snapshotEntries.push({
        role: String(input.role || `entry-${index}`),
        originalPath,
        payload,
        ...descriptor
      });
    }
    const manifest = {
      version: BACKUP_FORMAT_VERSION,
      id,
      createdAt: new Date().toISOString(),
      action: String(action || 'mutation').slice(0, 100),
      workspace: {
        id: String(workspace.id),
        name: String(workspace.name || workspace.id).slice(0, 300),
        rootFingerprint: workspaceRootFingerprint(workspace.root)
      },
      workSessionId: session.workSessionId,
      workSessionPrincipalId: session.workSessionPrincipalId,
      workSessionPrincipalName: session.workSessionPrincipalName,
      retainUntil: session.retainUntil,
      totalBytes: budget.bytes,
      fileCount: budget.files,
      entries: snapshotEntries
    };
    if (!validManifest(manifest, id)) throw new Error('Automatic backup manifest failed internal validation');
    await atomicWriteBackupJson(path.join(pending, BACKUP_MANIFEST_FILE), manifest);
    fsyncDirectory(pending);
    await pruneBackupStore({
      backupRetentionDays,
      maxBackupBytes,
      additionalBytes: budget.bytes,
      additionalSets: 1
    });
    await fsp.rename(pending, finalRoot);
    finalPublished = true;
    fsyncDirectory(BACKUP_ROOT);
    const operation = {
      version: BACKUP_FORMAT_VERSION,
      backupId: id,
      committedAt: new Date().toISOString(),
      mutationCompletedAt: null,
      mutationFailedAt: null,
      mutationErrorCode: null,
      transactionId: null
    };
    await atomicWriteBackupJson(path.join(finalRoot, BACKUP_OPERATION_FILE), operation);
    const summary = summaryFor(manifest, operation);
    await serializeCatalog(async () => {
      const records = [...await ensureCatalog(), summary].sort(
        (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id)
      );
      await persistIndexEvents([indexUpsert(summary)], records);
      catalog = records;
    });
    return summary;
  } catch (error) {
    await fsp.rm(pending, { recursive: true, force: true }).catch(() => {});
    if (finalPublished) {
      await fsp.rm(finalRoot, { recursive: true, force: true }).catch(() => {});
      catalog = null;
    }
    const wrapped = new Error(`Backup failed before mutation: ${error.message || error}`);
    wrapped.code = error?.code || 'backup_failed';
    wrapped.cause = error;
    throw wrapped;
  }
}

export function createBackupSnapshot(options = {}) {
  return serializeSnapshots(() => createBackupSnapshotInternal(options));
}

export async function completeBackupSnapshot(id, { transactionId = null } = {}) {
  return serializeCatalog(async () => {
    const set = await readSet(id);
    if (!set.committed) throw new Error(`Backup snapshot is not committed: ${id}`);
    if (set.operation.mutationFailedAt) {
      throw new Error(`Backup snapshot is already marked failed: ${id}`);
    }
    if (set.operation.mutationCompletedAt) return summaryFor(set.manifest, set.operation);
    const operation = {
      ...set.operation,
      mutationCompletedAt: new Date().toISOString(),
      mutationFailedAt: null,
      mutationErrorCode: null,
      transactionId: transactionId || set.operation.transactionId || null
    };
    await atomicWriteBackupJson(path.join(set.setRoot, BACKUP_OPERATION_FILE), operation);
    const summary = summaryFor(set.manifest, operation);
    const records = [...await ensureCatalog()].filter(item => item.id !== id);
    records.push(summary);
    records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
    try {
      await persistIndexEvents([indexUpsert(summary)], records);
    } finally {
      catalog = records;
    }
    return summary;
  });
}

export async function failBackupSnapshot(id, error = null) {
  return serializeCatalog(async () => {
    const set = await readSet(id);
    if (!set.committed) throw new Error(`Backup snapshot is not committed: ${id}`);
    if (set.operation.mutationCompletedAt || set.operation.mutationFailedAt) {
      return summaryFor(set.manifest, set.operation);
    }
    const operation = {
      ...set.operation,
      mutationCompletedAt: null,
      mutationFailedAt: new Date().toISOString(),
      mutationErrorCode: error?.code ? String(error.code).slice(0, 120) : null,
      transactionId: set.operation.transactionId || error?.transactionId || null
    };
    await atomicWriteBackupJson(path.join(set.setRoot, BACKUP_OPERATION_FILE), operation);
    const summary = summaryFor(set.manifest, operation);
    const records = [...await ensureCatalog()].filter(item => item.id !== id);
    records.push(summary);
    records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
    try {
      await persistIndexEvents([indexUpsert(summary)], records);
    } finally {
      catalog = records;
    }
    return summary;
  });
}

export async function discardBackupSnapshot(id) {
  return serializeCatalog(async () => {
    if (!BACKUP_ID.test(String(id || ''))) return false;
    await fsp.rm(path.join(requiredRoot(), id), { recursive: true, force: true }).catch(() => {});
    const before = [...await ensureCatalog()];
    const records = before.filter(item => item.id !== id);
    if (records.length === before.length) return false;
    try {
      await persistIndexEvents([indexDelete(id)], records);
    } finally {
      catalog = records;
    }
    return true;
  });
}

export async function listBackups({
  limit = 80,
  workspaceId = '',
  path: requestedPath = '',
  action = '',
  since = '',
  before = '',
  workSessionId = '',
  mutationState = '',
  committedOnly = true
} = {}) {
  const records = [...await ensureCatalog()];
  const cleanPath = requestedPath ? normalizedEntryPath(requestedPath) : '';
  const sinceMs = since ? Date.parse(since) : NaN;
  const beforeMs = before ? Date.parse(before) : NaN;
  if (since && !Number.isFinite(sinceMs)) throw new Error('since must be a valid timestamp');
  if (before && !Number.isFinite(beforeMs)) throw new Error('before must be a valid timestamp');
  if (mutationState && !['prepared', 'completed', 'failed'].includes(mutationState)) {
    throw new Error('mutationState must be prepared, completed, or failed');
  }
  return records.filter(item => {
    if (committedOnly && !item.committed) return false;
    if (workspaceId && item.workspaceId !== workspaceId) return false;
    if (action && item.action !== action) return false;
    if (workSessionId && item.workSessionId !== workSessionId) return false;
    if (mutationState && item.mutationState !== mutationState) return false;
    const created = Date.parse(item.createdAt);
    if (Number.isFinite(sinceMs) && created < sinceMs) return false;
    if (Number.isFinite(beforeMs) && created >= beforeMs) return false;
    if (cleanPath && !item.entries.some(entry =>
      entry.originalPath === cleanPath ||
      entry.originalPath.startsWith(`${cleanPath}/`) ||
      (entry.kind === 'directory' && cleanPath.startsWith(`${entry.originalPath}/`))
    )) return false;
    return true;
  }).slice(0, Math.max(1, Math.min(1000, Number(limit) || 80)));
}

export function assertBackupWorkspace(manifest, workspace) {
  if (!workspace?.id || !workspace?.root) throw new Error('A workspace is required for backup restore');
  if (manifest?.workspace?.id !== workspace.id) {
    const error = new Error(`Backup belongs to workspace ${manifest?.workspace?.id || 'unknown'}, not ${workspace.id}`);
    error.code = 'backup_workspace_mismatch';
    throw error;
  }
  if (manifest.workspace.rootFingerprint !== workspaceRootFingerprint(workspace.root)) {
    const error = new Error(`Backup workspace root no longer matches workspace ${workspace.id}`);
    error.code = 'backup_workspace_root_mismatch';
    throw error;
  }
  return true;
}

export async function backupEntry(backupIdValue, requestedPath = '') {
  const set = await readSet(backupIdValue);
  if (!set.committed) throw new Error(`Backup operation is not committed: ${backupIdValue}`);
  let entry = null;
  if (requestedPath) {
    const clean = normalizedEntryPath(requestedPath);
    entry = set.manifest.entries.find(item => item.originalPath === clean);
  } else if (set.manifest.entries.length === 1) {
    entry = set.manifest.entries[0];
  } else {
    throw new Error('entryPath is required when a backup contains multiple paths');
  }
  if (!entry) throw new Error(`Backup entry was not found: ${requestedPath || backupIdValue}`);
  const payloadPath = entry.kind === 'absent' ? null : path.resolve(set.setRoot, entry.payload);
  if (payloadPath && (!isInside(set.setRoot, payloadPath) || payloadPath === set.setRoot)) {
    throw new Error('Backup payload path escapes its set');
  }
  if (payloadPath) {
    const actual = await describePayload(
      payloadPath,
      { entries: 0, maxEntries: MAX_BACKUP_TREE_ENTRIES },
      entry.originalPath
    );
    if (
      actual.kind !== entry.kind ||
      actual.sizeBytes !== entry.sizeBytes ||
      actual.fileCount !== entry.fileCount ||
      actual.sha256 !== entry.sha256
    ) {
      const error = new Error(`Backup payload integrity check failed: ${backupIdValue}/${entry.originalPath}`);
      error.code = 'backup_integrity_failed';
      throw error;
    }
  }
  return {
    backupId: backupIdValue,
    setRoot: set.setRoot,
    manifest: set.manifest,
    operation: set.operation,
    entry: { ...entry },
    payloadPath
  };
}

async function fastIndexInitialization({ purgeLegacy = true } = {}) {
  const loaded = await loadIndex();
  if (!loaded) return null;
  const root = requiredRoot();
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  const expected = new Set(loaded.records.map(item => item.id));
  const removed = [];
  let mismatch = false;
  for (const entry of entries) {
    if (entry.name === BACKUP_INDEX_FILE) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && expected.has(entry.name)) {
      expected.delete(entry.name);
      continue;
    }
    if (entry.name.startsWith(BACKUP_PENDING_PREFIX)) {
      if (purgeLegacy) {
        await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
        removed.push({ name: entry.name, reason: 'pending' });
      } else {
        mismatch = true;
      }
      continue;
    }
    if (entry.isDirectory() && BACKUP_ID.test(entry.name)) {
      mismatch = true;
      continue;
    }
    if (purgeLegacy) {
      await fsp.rm(full, { recursive: true, force: true }).catch(() => {});
      removed.push({ name: entry.name, reason: 'legacy' });
    } else {
      mismatch = true;
    }
  }
  if (expected.size) mismatch = true;
  if (mismatch) return null;

  const records = loaded.records.map(item => ({ ...item }));
  const updates = [];
  for (let index = 0; index < records.length; index += 1) {
    if (records[index].mutationState !== 'prepared') continue;
    try {
      const set = await readSet(records[index].id);
      if (!set.committed) return null;
      const actual = summaryFor(set.manifest, set.operation);
      if (actual.mutationState !== records[index].mutationState) {
        records[index] = actual;
        updates.push(indexUpsert(actual));
      }
    } catch {
      return null;
    }
  }
  records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || b.id.localeCompare(a.id));
  catalog = records;
  catalogEventCount = loaded.eventCount;
  if (updates.length) {
    await persistIndexEvents(updates, records);
  }
  return { records, removed, source: 'index' };
}

export async function initializeBackupStore({ purgeLegacy = true } = {}) {
  return serializeCatalog(async () => {
    catalog = null;
    catalogEventCount = 0;
    const fast = await fastIndexInitialization({ purgeLegacy });
    if (fast) return fast;
    const rebuilt = await scanCatalog({ purgeLegacy });
    return { ...rebuilt, source: 'manifest-rebuild' };
  });
}

export async function backupStoreStatus() {
  const records = await ensureCatalog();
  const committed = records.filter(item => item.committed);
  const indexStat = BACKUP_ROOT
    ? await fsp.stat(path.join(BACKUP_ROOT, BACKUP_INDEX_FILE)).catch(() => null)
    : null;
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    indexVersion: BACKUP_INDEX_VERSION,
    backupSets: committed.length,
    maxBackupSets: MAX_BACKUP_SETS,
    preparedSnapshots: committed.filter(item => item.mutationState === 'prepared').length,
    completedSnapshots: committed.filter(item => item.mutationState === 'completed').length,
    failedSnapshots: committed.filter(item => item.mutationState === 'failed').length,
    backupFiles: committed.reduce((sum, item) => sum + Number(item.fileCount || 0), 0),
    backupBytes: committed.reduce((sum, item) => sum + Number(item.totalBytes || 0), 0),
    workspaces: new Set(committed.map(item => item.workspaceId)).size,
    indexEvents: catalogEventCount,
    indexBytes: indexStat?.size || 0,
    indexFile: BACKUP_ROOT ? path.join(BACKUP_ROOT, BACKUP_INDEX_FILE) : null
  };
}

export const __test = {
  BACKUP_ID,
  assertBackupOriginalPath,
  atomicWriteBackupJson,
  compactIndex,
  describePayload,
  fastIndexInitialization,
  normalizedEntryPath,
  readSet,
  scanCatalog,
  snapshotDescriptor,
  summaryFor,
  validManifest,
  validOperation,
  validSummaryRecord,
  workspaceRelativeSource
};
