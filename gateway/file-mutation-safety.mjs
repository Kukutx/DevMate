import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  assertCanMutate,
  audit,
  normalizeSlash,
  pathKey,
  readConfig,
  toolText
} from './local-shared.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';
import { registerToolDecorator } from './server-extension-host.mjs';
import {
  atomicCopyFile,
  atomicWriteText,
  transactionalDelete,
  transactionalMove
} from './file-transactions.mjs';
import {
  assertBackupWorkspace,
  backupEntry,
  completeBackupSnapshot,
  createBackupSnapshot,
  failBackupSnapshot
} from './backup-store.mjs';

const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
const CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : '';
const STATE_ROOT = CONFIG_DIR ? path.join(CONFIG_DIR, 'state') : '';
const BACKUP_ROOT = STATE_ROOT ? path.join(STATE_ROOT, 'backups') : '';
const TRANSACTION_ROOT = STATE_ROOT ? path.join(STATE_ROOT, 'file-transactions') : '';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DIRECTORY_MUTATION_ENTRIES = 20000;
const writeLocks = new Set();

const HIDDEN_DIRS = new Set([
  '.git', '.godot', 'node_modules', '.next', '.dart_tool', '.firebase', 'build', 'dist', 'coverage',
  'bin', 'obj', '.venv', 'venv', 'secrets', 'secret', 'credentials', 'credential', 'private-key',
  'private_keys', 'service-account', 'service_accounts'
]);
const BLOCKED_EXT = new Set(['.pem', '.key', '.pfx', '.p12', '.db', '.sqlite', '.sqlite3', '.log']);
const BLOCKED_BASENAME = new Set([
  'credentials.json', 'credential.json', 'secrets.json', 'secret.json', 'service-account.json',
  'service_account.json', 'service-account-key.json', 'service_account_key.json', 'id_rsa', 'id_dsa',
  'id_ecdsa', 'id_ed25519'
]);
const TEXT_EXT = new Set([
  '.md', '.mdx', '.txt', '.json', '.jsonc', '.yaml', '.yml', '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs',
  '.css', '.scss', '.sass', '.less', '.html', '.xml', '.cs', '.csproj', '.sln', '.dart', '.py', '.ps1', '.sh',
  '.bash', '.zsh', '.sql', '.toml', '.ini', '.config', '.cfg', '.props', '.targets', '.java', '.kt', '.kts', '.go',
  '.rs', '.php', '.rb', '.swift', '.vue', '.svelte', '.gd', '.godot', '.gdshader', '.gdshaderinc', '.shader',
  '.tscn', '.tres', '.uid', '.env.example', '.env.sample', '.sample'
]);
const ALLOW_BASENAME = new Set([
  'README', 'README.md', 'LICENSE', 'Dockerfile', 'Makefile', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'pubspec.yaml', 'pubspec.lock', 'global.json',
  'Directory.Packages.props'
]);
const SAFE_FILE_TOOLS = new Set(['write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup']);

function requireStateRoots() {
  if (!CONFIG_PATH || !STATE_ROOT || !BACKUP_ROOT || !TRANSACTION_ROOT) {
    throw new Error('DEVMATE_CONFIG is required for safe file mutations');
  }
}

function relParts(value) {
  return String(value || '').split(/[\\/]+/).filter(Boolean);
}

function isHidden(rel) {
  return relParts(rel).map(part => part.toLowerCase()).some(part => HIDDEN_DIRS.has(part));
}

function isEnvFile(base) {
  const value = String(base || '').toLowerCase();
  return value === '.env' || value.startsWith('.env.') || value === 'env.local' || value.endsWith('.env');
}

function isEnvExample(base) {
  const value = String(base || '').toLowerCase();
  return value === '.env.example' || value === '.env.sample' || value.endsWith('.env.example') || value.endsWith('.env.sample');
}

function isBinaryOrSecret(rel) {
  const base = path.basename(String(rel || ''));
  if (isHidden(rel)) return true;
  if (BLOCKED_BASENAME.has(base.toLowerCase())) return true;
  if (isEnvFile(base) && !isEnvExample(base)) return true;
  return BLOCKED_EXT.has(path.extname(base).toLowerCase());
}

function isTextAllowed(rel) {
  if (isBinaryOrSecret(rel)) return false;
  const base = path.basename(String(rel || ''));
  if (ALLOW_BASENAME.has(base)) return true;
  if (base.startsWith('.env') && isEnvExample(base)) return true;
  return TEXT_EXT.has(path.extname(base).toLowerCase());
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeResolve(root, rel) {
  const workspaceRoot = path.resolve(root);
  const full = path.resolve(workspaceRoot, String(rel || '.'));
  if (!isInside(workspaceRoot, full)) throw new Error(`Path escapes workspace root: ${rel}`);
  return full;
}

function resolvedRealTarget(root, full) {
  const rootReal = fs.realpathSync.native(path.resolve(root));
  const direct = fs.lstatSync(full, { throwIfNoEntry: false });
  if (direct?.isSymbolicLink()) throw new Error(`Write blocked: symlink/reparse target: ${normalizeSlash(path.relative(root, full))}`);
  let existing = path.dirname(full);
  while (!fs.lstatSync(existing, { throwIfNoEntry: false }) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, full));
  if (!isInside(rootReal, resolved)) {
    throw new Error(`Path escapes workspace root through symlink/reparse point: ${normalizeSlash(path.relative(root, full))}`);
  }
  if (direct) {
    const targetReal = fs.realpathSync.native(full);
    if (!isInside(rootReal, targetReal)) throw new Error(`Path escapes workspace root: ${normalizeSlash(path.relative(root, full))}`);
  }
  return { rootReal, resolved };
}

function realTargetRel(root, full) {
  const { rootReal, resolved } = resolvedRealTarget(root, full);
  return normalizeSlash(path.relative(rootReal, resolved));
}

function workspacePublic(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role || (workspace.reference ? 'reference' : 'active'),
    mode: workspace.mode || (workspace.reference ? 'readonly' : 'workspace-write'),
    reference: !!workspace.reference,
    writable: !workspace.reference && (workspace.mode || 'workspace-write') !== 'readonly',
    root: path.basename(workspace.root || '')
  };
}

function getWritableWorkspace(config, requested) {
  const workspace = resolveWorkspace(config, requested);
  assertCanMutate(config, 'Write');
  if (workspace.reference || (workspace.mode || 'workspace-write') === 'readonly') {
    throw new Error(`Workspace is readonly/reference: ${workspace.id}`);
  }
  return workspace;
}

function assertWritable(config, workspace, rel, { textOnly = false } = {}) {
  const normalized = normalizeSlash(path.normalize(String(rel || '.')));
  if (normalized === '.' || normalized === '') throw new Error('Write blocked: workspace root cannot be mutated directly');
  const full = safeResolve(workspace.root, rel);
  const targetRel = realTargetRel(workspace.root, full);
  if (isBinaryOrSecret(rel) || isBinaryOrSecret(targetRel)) {
    throw new Error(`Write blocked: secret/binary/hidden path: ${rel}`);
  }
  if (textOnly && (!isTextAllowed(rel) || !isTextAllowed(targetRel))) {
    throw new Error(`Write blocked: non-text path: ${rel}`);
  }
  return full;
}

async function assertDirectoryMutationAllowed(config, workspace, full, rel) {
  const stat = await fsp.lstat(full);
  if (stat.isSymbolicLink()) throw new Error(`Directory mutation blocked for symlink/reparse target: ${rel}`);
  if (!stat.isDirectory()) return stat;
  if (!config.permissions?.allowDirectoryMutations) {
    throw new Error('Directory mutation blocked. Enable devMate.allowDirectoryMutations to delete or move directories.');
  }
  let count = 0;
  const visited = new Set([pathKey(fs.realpathSync.native(full))]);
  async function scan(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      const childRel = normalizeSlash(path.relative(workspace.root, child));
      if (isBinaryOrSecret(childRel)) throw new Error(`Directory mutation blocked because it contains protected path: ${childRel}`);
      count += 1;
      if (count > MAX_DIRECTORY_MUTATION_ENTRIES) {
        throw new Error(`Directory mutation blocked because it contains more than ${MAX_DIRECTORY_MUTATION_ENTRIES} entries.`);
      }
      if (!entry.isDirectory()) continue;
      const childReal = fs.realpathSync.native(child);
      const workspaceReal = fs.realpathSync.native(workspace.root);
      if (!isInside(workspaceReal, childReal)) throw new Error(`Directory mutation blocked because it contains a directory outside the workspace: ${childRel}`);
      const key = pathKey(childReal);
      if (visited.has(key)) continue;
      visited.add(key);
      await scan(child);
    }
  }
  await scan(full);
  return stat;
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');
}

function expectedHash(value) {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return '';
  if (!/^[a-f0-9]{64}$/.test(clean)) throw new Error('expectedSha256 must be a 64-character hexadecimal digest');
  return clean;
}

async function assertExpectedRegularFileSha(full, stat, expected, label = 'Target') {
  const digest = expectedHash(expected);
  if (!digest) return null;
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large: ${stat.size} bytes`);
  const text = await fsp.readFile(full, 'utf8');
  const actual = sha256(text);
  if (actual !== digest) throw new Error(`sha256 mismatch: expected ${digest}, actual ${actual}`);
  return text;
}

function backupPolicy(config) {
  return {
    backupRetentionDays: config.maintenance?.backupRetentionDays,
    maxBackupBytes: config.maintenance?.maxBackupBytes
  };
}

async function createMutationSnapshot(config, workspace, action, entries, { attachWorkSession = true } = {}) {
  return createBackupSnapshot({ workspace, action, entries, attachWorkSession, ...backupPolicy(config) });
}

async function completeMutationSnapshot(snapshot, transaction = null) {
  if (!snapshot?.id) return snapshot || null;
  try {
    return await completeBackupSnapshot(snapshot.id, { transactionId: transaction?.transactionId || null });
  } catch (error) {
    return {
      ...snapshot,
      metadataWarning: String(error?.message || error).slice(0, 1000)
    };
  }
}

async function failMutationSnapshot(snapshot, error) {
  if (!snapshot?.id) return;
  try {
    await failBackupSnapshot(snapshot.id, error);
  } catch (metadataError) {
    if (error && typeof error === 'object') {
      error.backupMetadataWarning = String(metadataError?.message || metadataError).slice(0, 1000);
    }
  }
}

async function restoreDirectoryPayload(workspace, payloadPath, target, overwrite) {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.devmate-restore-' + crypto.randomBytes(6).toString('hex'));
  try {
    await fsp.cp(payloadPath, temporary, { recursive: true, force: false, errorOnExist: true, dereference: false });
    return await transactionalMove({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      source: temporary,
      target,
      overwrite
    });
  } finally {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function withPathLocks(paths, fn) {
  const keys = [...new Set(paths.map(pathKey))].sort();
  const busy = keys.find(key => writeLocks.has(key));
  if (busy) throw new Error(`Path locked by another write: ${paths[keys.indexOf(busy)] || busy}`);
  for (const key of keys) writeLocks.add(key);
  try { return await fn(); }
  finally { for (const key of keys) writeLocks.delete(key); }
}

function existingRegularFile(full, label = 'Target') {
  const stat = fs.lstatSync(full, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
  return stat;
}

async function writeFileTool(args = {}) {
  requireStateRoots();
  const { workspaceId, path: rel, content = '', append = false, createDirs = true, expectedSha256 = '' } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel, { textOnly: true });
  return withPathLocks([full], async () => {
    const stat = existingRegularFile(full);
    const expected = expectedHash(expectedSha256);
    if (expected && !stat) throw new Error('sha256 mismatch: expected ' + expected + ', actual missing');
    let before = null;
    if (stat && stat.size <= MAX_FILE_BYTES) before = await fsp.readFile(full, 'utf8');
    if (stat && stat.size > MAX_FILE_BYTES && (append || expected)) throw new Error('File too large: ' + stat.size + ' bytes');
    if (expected && sha256(before) !== expected) throw new Error('sha256 mismatch: expected ' + expected + ', actual ' + sha256(before));
    const next = append ? String(before || '') + String(content) : String(content);
    if (stat && before !== null && next === before) {
      return toolText({ workspace: workspacePublic(workspace), path: rel, backupId: null, sha256: sha256(next), written: false, noOp: true });
    }
    const snapshot = await createMutationSnapshot(config, workspace, 'write_file', [
      { role: 'target-before', originalPath: rel, sourcePath: stat ? full : null }
    ]);
    try {
      const transaction = await atomicWriteText({
        transactionRoot: TRANSACTION_ROOT,
        workspaceRoot: workspace.root,
        target: full,
        content: next,
        createDirs: createDirs !== false
      });
      const backup = await completeMutationSnapshot(snapshot, transaction);
      await audit('write_file', { workspace: workspace.id, path: rel, append: !!append, backupId: backup.id, transactionId: transaction.transactionId });
      return toolText({ workspace: workspacePublic(workspace), path: rel, backupId: backup.id, sha256: sha256(next), written: true });
    } catch (error) {
      await failMutationSnapshot(snapshot, error);
      throw error;
    }
  });
}

async function createFileTool(args = {}) {
  requireStateRoots();
  const { workspaceId, path: rel, content = '', overwrite = false, createDirs = true, mode = null } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel, { textOnly: true });
  return withPathLocks([full], async () => {
    const stat = existingRegularFile(full);
    if (stat && !overwrite) throw new Error('File exists; pass overwrite=true or use write_file/apply_patch');
    const next = String(content);
    if (stat && stat.size <= MAX_FILE_BYTES) {
      const before = await fsp.readFile(full, 'utf8');
      if (before === next) {
        return toolText({ workspace: workspacePublic(workspace), path: rel, backupId: null, sha256: sha256(next), created: false, overwritten: false, noOp: true });
      }
    }
    const snapshot = await createMutationSnapshot(config, workspace, 'create_file', [
      { role: 'target-before', originalPath: rel, sourcePath: stat ? full : null }
    ]);
    try {
      const transaction = await atomicWriteText({
        transactionRoot: TRANSACTION_ROOT,
        workspaceRoot: workspace.root,
        target: full,
        content: next,
        createDirs: createDirs !== false,
        mode
      });
      const backup = await completeMutationSnapshot(snapshot, transaction);
      await audit('create_file', { workspace: workspace.id, path: rel, overwrite: !!overwrite, backupId: backup.id, transactionId: transaction.transactionId });
      return toolText({
        workspace: workspacePublic(workspace), path: rel, backupId: backup.id, sha256: sha256(next),
        created: !stat, overwritten: !!stat
      });
    } catch (error) {
      await failMutationSnapshot(snapshot, error);
      throw error;
    }
  });
}

async function applyPatchTool(args = {}) {
  requireStateRoots();
  const rel = args.path || args.filePath;
  if (!rel) throw new Error('path is required');
  const { workspaceId, oldText, newText, expectedSha256, allOccurrences = false } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel, { textOnly: true });
  return withPathLocks([full], async () => {
    const stat = existingRegularFile(full);
    if (!stat) throw new Error('File does not exist');
    if (stat.size > MAX_FILE_BYTES) throw new Error('File too large: ' + stat.size + ' bytes');
    const text = await fsp.readFile(full, 'utf8');
    const beforeSha = sha256(text);
    const expected = expectedHash(expectedSha256);
    if (expected && expected !== beforeSha) throw new Error('sha256 mismatch: expected ' + expected + ', actual ' + beforeSha);
    if (!text.includes(oldText)) throw new Error('oldText not found');
    if (!allOccurrences && text.indexOf(oldText) !== text.lastIndexOf(oldText)) {
      throw new Error('oldText appears multiple times; set allOccurrences=true or provide more specific oldText');
    }
    const next = allOccurrences ? text.split(oldText).join(newText) : text.replace(oldText, newText);
    if (next === text) {
      return toolText({ workspace: workspacePublic(workspace), path: rel, backupId: null, oldSha256: beforeSha, newSha256: beforeSha, changed: false, noOp: true });
    }
    const snapshot = await createMutationSnapshot(config, workspace, 'apply_patch', [
      { role: 'target-before', originalPath: rel, sourcePath: full }
    ]);
    try {
      const transaction = await atomicWriteText({
        transactionRoot: TRANSACTION_ROOT,
        workspaceRoot: workspace.root,
        target: full,
        content: next,
        createDirs: false
      });
      const backup = await completeMutationSnapshot(snapshot, transaction);
      await audit('apply_patch', { workspace: workspace.id, path: rel, backupId: backup.id, transactionId: transaction.transactionId });
      return toolText({
        workspace: workspacePublic(workspace), path: rel, backupId: backup.id,
        oldSha256: beforeSha, newSha256: sha256(next), changed: true
      });
    } catch (error) {
      await failMutationSnapshot(snapshot, error);
      throw error;
    }
  });
}

async function deleteFileTool(args = {}) {
  requireStateRoots();
  const { workspaceId, path: rel, recursive = false, expectedSha256 = '' } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel);
  return withPathLocks([full], async () => {
    const stat = await assertDirectoryMutationAllowed(config, workspace, full, rel);
    const expected = expectedHash(expectedSha256);
    if (expected) await assertExpectedRegularFileSha(full, stat, expected);
    if (stat.isDirectory() && !recursive) throw new Error('Target is directory; pass recursive=true');
    const snapshot = await createMutationSnapshot(config, workspace, 'delete_file', [
      { role: 'target-before', originalPath: rel, sourcePath: full }
    ]);
    try {
      const transaction = await transactionalDelete({
        transactionRoot: TRANSACTION_ROOT,
        workspaceRoot: workspace.root,
        target: full
      });
      const backup = await completeMutationSnapshot(snapshot, transaction);
      await audit('delete_file', {
        workspace: workspace.id, path: rel, recursive: !!recursive,
        backupId: backup.id, transactionId: transaction.transactionId
      });
      return toolText({ workspace: workspacePublic(workspace), path: rel, backupId: backup.id, deleted: true });
    } catch (error) {
      await failMutationSnapshot(snapshot, error);
      throw error;
    }
  });
}

async function moveFileTool(args = {}) {
  requireStateRoots();
  const { workspaceId, from, to, overwrite = false } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const source = assertWritable(config, workspace, from);
  const target = assertWritable(config, workspace, to);
  if (pathKey(source) === pathKey(target)) {
    return toolText({ workspace: workspacePublic(workspace), from, to, backupId: null, moved: false, noOp: true });
  }
  return withPathLocks([source, target], async () => {
    const sourceStat = await assertDirectoryMutationAllowed(config, workspace, source, from);
    const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetStat?.isSymbolicLink()) throw new Error('Write blocked: symlink/reparse target: ' + to);
    if (targetStat && !overwrite) throw new Error('Destination exists; pass overwrite=true');
    if (targetStat) await assertDirectoryMutationAllowed(config, workspace, target, to);
    const snapshot = await createMutationSnapshot(config, workspace, 'move_file', [
      { role: 'source-before', originalPath: from, sourcePath: source },
      { role: 'target-before', originalPath: to, sourcePath: targetStat ? target : null }
    ]);
    try {
      const transaction = await transactionalMove({
        transactionRoot: TRANSACTION_ROOT,
        workspaceRoot: workspace.root,
        source,
        target,
        overwrite: !!overwrite
      });
      const backup = await completeMutationSnapshot(snapshot, transaction);
      await audit('move_file', {
        workspace: workspace.id, from, to, overwrite: !!overwrite,
        sourceIsDirectory: sourceStat.isDirectory(), backupId: backup.id,
        transactionId: transaction.transactionId
      });
      return toolText({ workspace: workspacePublic(workspace), from, to, backupId: backup.id, moved: true });
    } catch (error) {
      await failMutationSnapshot(snapshot, error);
      throw error;
    }
  });
}

async function restoreBackupTool(args = {}) {
  requireStateRoots();
  const { workspaceId, backupId, entryPath = '', targetPath, overwrite = true } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const source = await backupEntry(String(backupId || ''), entryPath);
  assertBackupWorkspace(source.manifest, workspace);
  const rel = targetPath || source.entry.originalPath;
  const target = assertWritable(config, workspace, rel);
  return withPathLocks([target], async () => {
    const current = fs.lstatSync(target, { throwIfNoEntry: false });
    if (current?.isSymbolicLink()) throw new Error('Write blocked: symlink/reparse target: ' + rel);
    if (current && !overwrite) throw new Error('Target exists; pass overwrite=true to restore over it');
    if (current?.isDirectory()) await assertDirectoryMutationAllowed(config, workspace, target, rel);
    if (!current && source.entry.kind === 'absent') {
      return toolText({ workspace: workspacePublic(workspace), backupId, entryPath: source.entry.originalPath, targetPath: rel, currentBackupId: null, restored: false, noOp: true });
    }
    const snapshot = await createMutationSnapshot(config, workspace, 'restore_backup', [
      { role: 'target-before', originalPath: rel, sourcePath: current ? target : null }
    ], { attachWorkSession: args._rollbackInternal !== true });
    try {
      let transaction = null;
      if (source.entry.kind === 'absent') {
        transaction = await transactionalDelete({ transactionRoot: TRANSACTION_ROOT, workspaceRoot: workspace.root, target });
      } else if (source.entry.kind === 'file') {
        if (current && !current.isFile()) throw new Error('Restore target type does not match file backup');
        transaction = await atomicCopyFile({
          transactionRoot: TRANSACTION_ROOT,
          workspaceRoot: workspace.root,
          source: source.payloadPath,
          target,
          createDirs: true
        });
      } else {
        if (current && !current.isDirectory()) throw new Error('Restore target type does not match directory backup');
        await fsp.mkdir(path.dirname(target), { recursive: true });
        transaction = await restoreDirectoryPayload(workspace, source.payloadPath, target, !!overwrite);
      }
      const currentBackup = await completeMutationSnapshot(snapshot, transaction);
      await audit('restore_backup', {
        workspace: workspace.id, backupId: source.backupId, entryPath: source.entry.originalPath,
        targetPath: rel, currentBackupId: currentBackup.id, transactionId: transaction?.transactionId || null
      });
      return toolText({
        workspace: workspacePublic(workspace), backupId: source.backupId, entryPath: source.entry.originalPath,
        targetPath: rel, currentBackupId: currentBackup.id, sha256: source.entry.sha256 || null,
        kind: source.entry.kind, restored: true
      });
    } catch (error) {
      await failMutationSnapshot(snapshot, error);
      throw error;
    }
  });
}

const HANDLERS = Object.freeze({
  write_file: writeFileTool,
  create_file: createFileTool,
  apply_patch: applyPatchTool,
  delete_file: deleteFileTool,
  move_file: moveFileTool,
  restore_backup: restoreBackupTool
});

export function safeFileMutationHandler(name) {
  return HANDLERS[name] || null;
}

export function installFileMutationSafety(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.file-mutation-safety',
    order: 5,
    decorate({ name, handler }) {
      if (!SAFE_FILE_TOOLS.has(name)) return { handler };
      return { handler: HANDLERS[name] };
    }
  });
}

export const __test = {
  ALLOW_BASENAME,
  BACKUP_ROOT,
  BLOCKED_BASENAME,
  BLOCKED_EXT,
  HANDLERS,
  HIDDEN_DIRS,
  SAFE_FILE_TOOLS,
  TEXT_EXT,
  TRANSACTION_ROOT,
  assertDirectoryMutationAllowed,
  assertExpectedRegularFileSha,
  assertWritable,
  expectedHash,
  isBinaryOrSecret,
  isTextAllowed,
  resolvedRealTarget,
  withPathLocks
};
