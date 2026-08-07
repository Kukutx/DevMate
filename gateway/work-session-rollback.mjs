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
import { normalizeDeploymentConfig } from './team-access.mjs';
import { assertWorkspaceLease } from './workspace-leases.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

const BACKUP_ROOT = CONFIG_PATH ? path.join(path.dirname(CONFIG_PATH), 'state', 'backups') : '';
const ROLLBACK_ACTIONS = new Set(['write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup']);
const SESSION_ACTIONS = new Set(['work_session_start', 'work_session_finish', 'work_session_rollback']);

function normalizeSlash(value) { return String(value || '').replace(/\\/g, '/'); }
function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertWorkspaceTarget(config, workspace, rel) {
  assertCanMutate(config, 'Work session rollback');
  if (!workspace || workspace.reference || workspace.mode === 'readonly') {
    throw new Error(`Workspace is readonly/reference: ${workspace?.id || 'unknown'}`);
  }
  const root = path.resolve(workspace.root);
  const target = path.resolve(root, String(rel || ''));
  if (!isInside(root, target) || target === root) throw new Error(`Rollback path escapes workspace root: ${rel}`);
  const rootReal = fs.realpathSync.native(root);
  if (fs.existsSync(target)) {
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
  const stat = fs.statSync(candidate, { throwIfNoEntry: false });
  if (!stat) return null;
  const rootReal = fs.realpathSync.native(root);
  const sourceReal = fs.realpathSync.native(candidate);
  if (!isInside(rootReal, sourceReal)) throw new Error('Backup path escapes DevMate backup root');
  return { path: sourceReal, stat };
}

async function backupCurrent(target, rel) {
  const stat = await fsp.stat(target).catch(() => null);
  if (!stat) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeRel = normalizeSlash(rel).split('/').filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '_')).join('/') || 'workspace-root';
  const destination = path.join(BACKUP_ROOT, stamp, safeRel);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (stat.isDirectory()) await fsp.cp(target, destination, { recursive: true, force: false });
  else await fsp.copyFile(target, destination);
  return destination;
}

async function restoreBackup(config, workspace, backupPath, rel, dryRun) {
  if (!backupPath || String(backupPath).startsWith('backup_failed:')) {
    return { path: rel, backupPath, restored: false, reason: 'missing backup' };
  }
  const source = assertBackupSource(backupPath);
  if (!source) return { path: rel, backupPath, restored: false, reason: 'backup not found' };
  const target = assertWorkspaceTarget(config, workspace, rel);
  if (dryRun) return { path: rel, backupPath: source.path, restored: false, dryRun: true };
  const currentBackup = fs.existsSync(target) ? await backupCurrent(target, rel) : null;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) await fsp.rm(target, { recursive: true, force: true });
  if (source.stat.isDirectory()) await fsp.cp(source.path, target, { recursive: true, force: false });
  else await fsp.copyFile(source.path, target);
  return { path: rel, backupPath: source.path, currentBackup, restored: true };
}

async function removePath(config, workspace, rel, dryRun) {
  const target = assertWorkspaceTarget(config, workspace, rel);
  if (dryRun) return { path: rel, removed: false, dryRun: true };
  if (!fs.existsSync(target)) return { path: rel, removed: false, reason: 'target already absent' };
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

export async function rollbackWorkSession({ workSessionId, principal, dryRun = false, limit = 1000 }) {
  const id = String(workSessionId || '').trim();
  if (!id) throw new Error('workSessionId is required');
  if (!principal?.id) throw new Error('Authenticated principal is required');
  const config = normalizeDeploymentConfig(readConfig());
  assertCanMutate(config, 'Work session rollback');
  const entries = (await readAuditEntries(10000)).filter(entry => entry.workSessionId === id).slice(-limit);
  if (!entries.length) throw new Error(`Work session audit history not found: ${id}`);

  const start = entries.find(entry => entry.action === 'work_session_start');
  const canManageOthers = principal.role === 'owner' || principal.role === 'maintainer';
  if (start?.principalId && start.principalId !== principal.id && !canManageOthers) {
    throw new Error(`Work session ${id} belongs to ${start.principalName || start.principalId}`);
  }

  const workspaceIds = [...new Set(entries.map(entry => entry.workspace).filter(Boolean))];
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
    catch (error) { results.push({ entry, rollback: { failed: true, error: error.message } }); }
  }
  await audit('work_session_rollback', {
    principalId: principal.id,
    targetWorkSessionId: id,
    dryRun,
    resultCount: results.length,
    workspaces: workspaceIds
  }, { workSessionId: id });
  return { workSessionId: id, dryRun, results };
}

export const __test = {
  assertBackupSource,
  assertWorkspaceTarget,
  isInside,
  rollbackEntry
};
