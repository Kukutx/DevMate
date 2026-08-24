import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CONFIG_PATH,
  assertCanMutate,
  audit,
  readAuditEntries,
  readConfig
} from './local-shared.mjs';
import { isSensitiveWorkspacePath, sensitiveWorkspacePathReason } from './sensitive-path-policy.mjs';
import { normalizeInstanceConfig } from './team-access.mjs';
import { assertWorkspaceLease } from './workspace-leases.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

const BACKUP_ROOT = CONFIG_PATH ? path.join(path.dirname(CONFIG_PATH), 'state', 'backups') : '';
const ROLLBACK_ACTIONS = new Set(['write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup']);
const SESSION_ACTIONS = new Set(['work_session_start', 'work_session_finish', 'work_session_rollback']);
const MAX_ROLLBACK_SCAN_ENTRIES = 20_000;

function normalizeSlash(value) { return String(value || '').replace(/\\/g, '/'); }
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function protectedPathError(rel, context = 'Rollback path') {
  const error = new Error(`${context} is protected by DevMate credential policy: ${rel}`);
  error.code = 'sensitive_workspace_path';
  error.reason = sensitiveWorkspacePathReason(rel);
  return error;
}

function assertSafeRollbackRel(rel, context = 'Rollback path') {
  const normalized = normalizeSlash(String(rel || '').trim());
  if (isSensitiveWorkspacePath(normalized)) throw protectedPathError(normalized, context);
  return normalized;
}

function assertWorkspaceTarget(config, workspace, rel) {
  assertCanMutate(config, 'Work session rollback');
  if (!workspace || workspace.reference || workspace.mode === 'readonly') {
    throw new Error(`Workspace is readonly/reference: ${workspace?.id || 'unknown'}`);
  }
  assertSafeRollbackRel(rel);
  const root = path.resolve(workspace.root);
  const target = path.resolve(root, String(rel || ''));
  if (!isInside(root, target) || target === root) throw new Error(`Rollback path escapes workspace root: ${rel}`);
  const rootReal = fs.realpathSync.native(root);
  const direct = fs.lstatSync(target, { throwIfNoEntry: false });
  if (direct?.isSymbolicLink()) throw new Error(`Rollback path is a symlink/reparse target: ${rel}`);
  if (direct) {
    const targetReal = fs.realpathSync.native(target);
    if (!isInside(rootReal, targetReal)) throw new Error(`Rollback path escapes workspace root through symlink: ${rel}`);
    return target;
  }
  let existing = path.dirname(target);
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, target));
  if (!isInside(rootReal, resolved)) throw new Error(`Rollback path escapes workspace root through symlink: ${rel}`);
  return target;
}

function assertBackupSource(backupPath) {
  if (!BACKUP_ROOT) throw new Error('DevMate backup root is unavailable');
  const root = path.resolve(BACKUP_ROOT);
  const candidate = path.resolve(String(backupPath || ''));
  if (!isInside(root, candidate)) throw new Error('Backup path is outside DevMate backup root');
  const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Error('Backup source cannot be a symlink/reparse point');
  const rootReal = fs.realpathSync.native(root);
  const sourceReal = fs.realpathSync.native(candidate);
  if (!isInside(rootReal, sourceReal)) throw new Error('Backup path escapes DevMate backup root');
  return { path: sourceReal, stat };
}

async function assertTreeSafe(root, destinationRel) {
  const rootStat = await fsp.lstat(root).catch(() => null);
  if (!rootStat) return;
  if (rootStat.isSymbolicLink()) throw new Error('Rollback tree root cannot be a symlink/reparse point');
  if (!rootStat.isDirectory()) return;
  let count = 0;
  async function scan(directory, nested = '') {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (count > MAX_ROLLBACK_SCAN_ENTRIES) {
        const error = new Error(`Rollback tree safety scan exceeds ${MAX_ROLLBACK_SCAN_ENTRIES} entries`);
        error.code = 'work_session_rollback_scan_limit';
        throw error;
      }
      const childNested = nested ? `${nested}/${entry.name}` : entry.name;
      const intended = normalizeSlash(path.posix.join(normalizeSlash(destinationRel), childNested));
      if (isSensitiveWorkspacePath(intended)) throw protectedPathError(intended, 'Rollback tree entry');
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      const stat = await fsp.lstat(child).catch(() => null);
      if (!stat || stat.isSymbolicLink()) continue;
      await scan(child, childNested);
    }
  }
  await scan(root);
}

async function backupCurrent(target, rel) {
  const stat = await fsp.lstat(target).catch(() => null);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new Error(`Rollback backup target is a symlink/reparse point: ${rel}`);
  await assertTreeSafe(target, rel);
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
  const safeRel = normalizeSlash(rel).split('/').filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '_')).join('/') || 'workspace-root';
  const destination = path.join(BACKUP_ROOT, stamp, safeRel);
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (stat.isDirectory()) await fsp.cp(target, destination, { recursive: true, force: false, errorOnExist: true, dereference: false });
  else await fsp.copyFile(target, destination, fs.constants.COPYFILE_EXCL);
  return destination;
}

async function restoreBackup(config, workspace, backupPath, rel, dryRun) {
  if (!backupPath || String(backupPath).startsWith('backup_failed:')) {
    return { path: rel, backupPath, restored: false, reason: 'missing backup' };
  }
  const target = assertWorkspaceTarget(config, workspace, rel);
  const source = assertBackupSource(backupPath);
  if (!source) return { path: rel, backupPath, restored: false, reason: 'backup not found' };
  await assertTreeSafe(source.path, rel);
  if (dryRun) return { path: rel, backupPath: source.path, restored: false, dryRun: true };
  const currentBackup = fs.existsSync(target) ? await backupCurrent(target, rel) : null;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    await assertTreeSafe(target, rel);
    await fsp.rm(target, { recursive: true, force: true });
  }
  if (source.stat.isDirectory()) await fsp.cp(source.path, target, { recursive: true, force: false, errorOnExist: true, dereference: false });
  else await fsp.copyFile(source.path, target, fs.constants.COPYFILE_EXCL);
  return { path: rel, backupPath: source.path, currentBackup, restored: true };
}

async function removePath(config, workspace, rel, dryRun) {
  const target = assertWorkspaceTarget(config, workspace, rel);
  if (dryRun) return { path: rel, removed: false, dryRun: true };
  if (!fs.existsSync(target)) return { path: rel, removed: false, reason: 'target already absent' };
  await assertTreeSafe(target, rel);
  const currentBackup = await backupCurrent(target, rel);
  await fsp.rm(target, { recursive: true, force: true });
  return { path: rel, currentBackup, removed: true };
}

async function rollbackEntry(config, entry, dryRun) {
  if (!ROLLBACK_ACTIONS.has(entry.action)) {
    return { action: entry.action, skipped: true, reason: 'no safe automatic rollback for this action' };
  }
  const workspace = resolveWorkspace(config, entry.workspace);
  if (entry.action === 'write_file' || entry.action === 'apply_patch' || entry.action === 'create_file') {
    return entry.backup
      ? restoreBackup(config, workspace, entry.backup, entry.path, dryRun)
      : removePath(config, workspace, entry.path, dryRun);
  }
  if (entry.action === 'delete_file') {
    return restoreBackup(config, workspace, entry.backup, entry.path, dryRun);
  }
  if (entry.action === 'move_file') {
    const results = [];
    if (entry.sourceBackup) results.push(await restoreBackup(config, workspace, entry.sourceBackup, entry.from, dryRun));
    else if (entry.to) results.push({ path: entry.from, restored: false, reason: 'source backup unavailable' });
    if (entry.destBackup) results.push(await restoreBackup(config, workspace, entry.destBackup, entry.to, dryRun));
    else if (entry.to) results.push(await removePath(config, workspace, entry.to, dryRun));
    return { path: entry.from, to: entry.to, results };
  }
  if (entry.action === 'restore_backup') {
    return entry.currentBackup
      ? restoreBackup(config, workspace, entry.currentBackup, entry.targetPath, dryRun)
      : removePath(config, workspace, entry.targetPath, dryRun);
  }
  return { action: entry.action, skipped: true, reason: 'unsupported rollback action' };
}

export async function rollbackWorkSession({ workSessionId, principal, dryRun = false, force = false, limit = 1000 }) {
  const id = String(workSessionId || '').trim();
  if (!id) throw new Error('workSessionId is required');
  if (!principal?.id) throw new Error('Authenticated principal is required');
  const config = normalizeInstanceConfig(readConfig());
  assertCanMutate(config, 'Work session rollback');
  const entries = (await readAuditEntries(10000)).filter(entry => entry.workSessionId === id).slice(-limit);
  if (!entries.length) throw new Error(`Work session audit history not found: ${id}`);

  const start = entries.find(entry => entry.action === 'work_session_start');
  const canManageOthers = principal.role === 'owner' || principal.role === 'maintainer';
  if (!start?.principalId) {
    throw new Error(`Work session ownership metadata is unavailable: ${id}`);
  }
  if (start.principalId !== principal.id) {
    if (!canManageOthers) {
      throw new Error(`Work session ${id} belongs to ${start.principalName || start.principalId}`);
    }
    if (!force) {
      throw new Error(`Rollback of another principal's work session requires force=true: ${id}`);
    }
  }

  const workspaceIds = [...new Set(entries.map(entry => entry.workspace).filter(Boolean))];
  if (!workspaceIds.length) throw new Error(`Work session has no rollback workspace metadata: ${id}`);
  for (const workspaceId of workspaceIds) {
    if (principal.workspaceIds?.length && !principal.workspaceIds.includes(workspaceId)) {
      throw new Error(`Principal ${principal.id} is not allowed to rollback workspace ${workspaceId}`);
    }
    assertWorkspaceLease({ workspaceId, principal, capability: 'write', config });
  }

  const results = [];
  for (const entry of entries.slice().reverse()) {
    if (SESSION_ACTIONS.has(entry.action)) continue;
    try { results.push({ entry, rollback: await rollbackEntry(config, entry, dryRun) }); }
    catch (error) { results.push({ entry, rollback: { failed: true, error: error.message, code: error.code || null } }); }
  }
  await audit('work_session_rollback', {
    principalId: principal.id,
    targetWorkSessionId: id,
    dryRun,
    force,
    resultCount: results.length,
    workspaces: workspaceIds
  }, { workSessionId: id });
  return { workSessionId: id, dryRun, force, results };
}

export const __test = {
  MAX_ROLLBACK_SCAN_ENTRIES,
  assertBackupSource,
  assertSafeRollbackRel,
  assertTreeSafe,
  assertWorkspaceTarget,
  isInside,
  rollbackEntry
};
