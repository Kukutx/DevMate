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
  let existing = direct ? path.dirname(full) : path.dirname(full);
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

function backupSafeRel(rel) {
  const parts = normalizeSlash(rel).split('/').filter(part => part && part !== '.' && part !== '..');
  const safe = parts.map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '_'));
  return safe.length ? safe.join('/') : 'workspace-root';
}

function backupDestination(rel) {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  return path.join(BACKUP_ROOT, stamp, backupSafeRel(rel));
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

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
  }
}

async function syncTree(root) {
  const stat = await fsp.lstat(root);
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    await syncFile(root);
    fsyncDirectory(path.dirname(root));
    return;
  }
  if (!stat.isDirectory()) return;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) await syncTree(path.join(root, entry.name));
  fsyncDirectory(root);
  fsyncDirectory(path.dirname(root));
}

async function durableBackup(source, rel, destination = backupDestination(rel)) {
  const stat = await fsp.lstat(source).catch(() => null);
  if (!stat) return null;
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    if (stat.isDirectory()) {
      await fsp.cp(source, destination, { recursive: true, force: false, errorOnExist: true, dereference: false });
    } else if (stat.isFile()) {
      await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      try { await fsp.chmod(destination, stat.mode & 0o777); } catch {}
    } else {
      throw new Error('Unsupported backup target type');
    }
    await syncTree(destination);
    return destination;
  } catch (error) {
    await fsp.rm(path.dirname(destination), { recursive: true, force: true }).catch(() => {});
    throw new Error(`Backup failed before mutation: ${error.message || error}`);
  }
}

function backupRelativePath(backupFull) {
  const backupRoot = fs.realpathSync.native(BACKUP_ROOT);
  const stat = fs.lstatSync(backupFull, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('Only regular-file backup restore is supported');
  const full = fs.realpathSync.native(backupFull);
  if (!isInside(backupRoot, full)) throw new Error('Backup path is outside DevMate backup root');
  const parts = path.relative(backupRoot, full).split(path.sep).filter(Boolean);
  if (parts.length < 2) throw new Error('Backup path does not include an original relative path');
  return normalizeSlash(parts.slice(1).join('/'));
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
  const { workspaceId, path: rel, content = '', append = false, createDirs = true } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel, { textOnly: true });
  return withPathLocks([full], async () => {
    const stat = existingRegularFile(full);
    let before = '';
    if (append && stat) {
      if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large: ${stat.size} bytes`);
      before = await fsp.readFile(full, 'utf8');
    }
    const backup = stat ? await durableBackup(full, rel) : null;
    const next = append ? `${before}${content}` : String(content);
    const transaction = await atomicWriteText({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      target: full,
      content: next,
      createDirs: createDirs !== false
    });
    await audit('write_file', { workspace: workspace.id, path: rel, append: !!append, backup, transactionId: transaction.transactionId });
    return toolText({ workspace: workspacePublic(workspace), path: rel, backup, sha256: sha256(next), written: true });
  });
}

async function createFileTool(args = {}) {
  requireStateRoots();
  const { workspaceId, path: rel, content = '', overwrite = false, createDirs = true } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel, { textOnly: true });
  return withPathLocks([full], async () => {
    const stat = existingRegularFile(full);
    if (stat && !overwrite) throw new Error('File exists; pass overwrite=true or use write_file/apply_patch');
    const backup = stat ? await durableBackup(full, rel) : null;
    const transaction = await atomicWriteText({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      target: full,
      content: String(content),
      createDirs: createDirs !== false
    });
    await audit('create_file', { workspace: workspace.id, path: rel, overwrite: !!overwrite, backup, transactionId: transaction.transactionId });
    return toolText({
      workspace: workspacePublic(workspace), path: rel, backup, sha256: sha256(content),
      created: !stat, overwritten: !!stat
    });
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
    if (stat.size > MAX_FILE_BYTES) throw new Error(`File too large: ${stat.size} bytes`);
    const text = await fsp.readFile(full, 'utf8');
    const beforeSha = sha256(text);
    if (expectedSha256 && expectedSha256 !== beforeSha) throw new Error(`sha256 mismatch: expected ${expectedSha256}, actual ${beforeSha}`);
    if (!text.includes(oldText)) throw new Error('oldText not found');
    if (!allOccurrences && text.indexOf(oldText) !== text.lastIndexOf(oldText)) {
      throw new Error('oldText appears multiple times; set allOccurrences=true or provide more specific oldText');
    }
    const next = allOccurrences ? text.split(oldText).join(newText) : text.replace(oldText, newText);
    const backup = await durableBackup(full, rel);
    const transaction = await atomicWriteText({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      target: full,
      content: next,
      createDirs: false
    });
    await audit('apply_patch', { workspace: workspace.id, path: rel, backup, transactionId: transaction.transactionId });
    return toolText({
      workspace: workspacePublic(workspace), path: rel, backup,
      oldSha256: beforeSha, newSha256: sha256(next), changed: true
    });
  });
}

async function deleteFileTool(args = {}) {
  requireStateRoots();
  const { workspaceId, path: rel, recursive = false } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const full = assertWritable(config, workspace, rel);
  return withPathLocks([full], async () => {
    const stat = await assertDirectoryMutationAllowed(config, workspace, full, rel);
    if (stat.isDirectory() && !recursive) throw new Error('Target is directory; pass recursive=true');
    let backup = null;
    const transaction = await transactionalDelete({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      target: full,
      backup: async rollback => {
        backup = await durableBackup(rollback, rel);
        return backup;
      }
    });
    await audit('delete_file', {
      workspace: workspace.id, path: rel, recursive: !!recursive,
      backup, transactionId: transaction.transactionId
    });
    return toolText({ workspace: workspacePublic(workspace), path: rel, backup, deleted: true });
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
    return toolText({ workspace: workspacePublic(workspace), from, to, sourceBackup: null, destBackup: null, moved: false, noOp: true });
  }
  return withPathLocks([source, target], async () => {
    const sourceStat = await assertDirectoryMutationAllowed(config, workspace, source, from);
    const targetStat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (targetStat?.isSymbolicLink()) throw new Error(`Write blocked: symlink/reparse target: ${to}`);
    if (targetStat && !overwrite) throw new Error('Destination exists; pass overwrite=true');
    if (targetStat) await assertDirectoryMutationAllowed(config, workspace, target, to);
    const sourceBackup = await durableBackup(source, from);
    const destBackup = targetStat ? await durableBackup(target, to) : null;
    const transaction = await transactionalMove({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      source,
      target,
      overwrite: !!overwrite
    });
    await audit('move_file', {
      workspace: workspace.id, from, to, overwrite: !!overwrite,
      sourceIsDirectory: sourceStat.isDirectory(), sourceBackup, destBackup,
      transactionId: transaction.transactionId
    });
    return toolText({ workspace: workspacePublic(workspace), from, to, sourceBackup, destBackup, moved: true });
  });
}

async function restoreBackupTool(args = {}) {
  requireStateRoots();
  const { workspaceId, backupPath: requestedBackup, targetPath, overwrite = true } = args;
  const config = readConfig();
  const workspace = getWritableWorkspace(config, workspaceId);
  const backupFull = path.resolve(String(requestedBackup || ''));
  const rel = targetPath || backupRelativePath(backupFull);
  const target = assertWritable(config, workspace, rel);
  return withPathLocks([target], async () => {
    backupRelativePath(backupFull);
    const current = fs.lstatSync(target, { throwIfNoEntry: false });
    if (current?.isSymbolicLink()) throw new Error(`Write blocked: symlink/reparse target: ${rel}`);
    if (current && !current.isFile()) throw new Error('Restore target is not a regular file');
    if (current && !overwrite) throw new Error('Target exists; pass overwrite=true to restore over it');
    const currentBackup = current ? await durableBackup(target, rel) : null;
    const transaction = await atomicCopyFile({
      transactionRoot: TRANSACTION_ROOT,
      workspaceRoot: workspace.root,
      source: backupFull,
      target,
      createDirs: true
    });
    const restored = await fsp.readFile(target);
    await audit('restore_backup', {
      workspace: workspace.id, backupPath: backupFull, targetPath: rel,
      currentBackup, transactionId: transaction.transactionId
    });
    return toolText({
      workspace: workspacePublic(workspace), backupPath: backupFull, targetPath: rel,
      currentBackup, sha256: crypto.createHash('sha256').update(restored).digest('hex'), restored: true
    });
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
  assertWritable,
  backupRelativePath,
  durableBackup,
  isBinaryOrSecret,
  isTextAllowed,
  resolvedRealTarget,
  withPathLocks
};
