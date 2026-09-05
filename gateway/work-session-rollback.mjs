import { listBackups } from './backup-store.mjs';
import { safeFileMutationHandler } from './file-mutation-safety.mjs';
import { assertCanMutate, audit, readConfig } from './local-shared.mjs';
import { normalizeInstanceConfig } from './team-access.mjs';
import { assertWorkspaceLease } from './workspace-leases.mjs';

const ROLLBACK_ACTIONS = new Set(['write_file', 'create_file', 'apply_patch', 'delete_file', 'move_file', 'restore_backup']);

function sessionOwner(snapshots) {
  const ids = [...new Set(snapshots.map(item => item.workSessionPrincipalId).filter(Boolean))];
  if (ids.length !== 1) throw new Error('Work session backup ownership metadata is unavailable or inconsistent');
  const first = snapshots.find(item => item.workSessionPrincipalId === ids[0]);
  return {
    id: ids[0],
    name: first?.workSessionPrincipalName || ids[0]
  };
}

function rollbackEntries(snapshot) {
  if (!ROLLBACK_ACTIONS.has(snapshot.action)) return [];
  return Array.isArray(snapshot.entries) ? snapshot.entries : [];
}

async function rollbackSnapshot(snapshot, dryRun) {
  const entries = rollbackEntries(snapshot);
  if (!entries.length) {
    return { backupId: snapshot.id, action: snapshot.action, skipped: true, reason: 'no safe automatic rollback entries' };
  }
  if (dryRun) {
    return {
      backupId: snapshot.id,
      action: snapshot.action,
      workspaceId: snapshot.workspaceId,
      entries: entries.map(entry => ({
        originalPath: entry.originalPath,
        kind: entry.kind,
        role: entry.role,
        dryRun: true
      }))
    };
  }
  const restore = safeFileMutationHandler('restore_backup');
  if (typeof restore !== 'function') throw new Error('Crash-safe backup restore handler is unavailable');
  const restored = [];
  for (const entry of entries) {
    try {
      restored.push(await restore({
        workspaceId: snapshot.workspaceId,
        backupId: snapshot.id,
        entryPath: entry.originalPath,
        overwrite: true,
        _rollbackInternal: true
      }));
    } catch (error) {
      restored.push({
        backupId: snapshot.id,
        path: entry.originalPath,
        failed: true,
        error: String(error?.message || error),
        code: error?.code || null
      });
    }
  }
  return {
    backupId: snapshot.id,
    action: snapshot.action,
    workspaceId: snapshot.workspaceId,
    restored
  };
}

export async function rollbackWorkSession({ workSessionId, principal, dryRun = false, force = false, limit = 1000 }) {
  const id = String(workSessionId || '').trim();
  if (!id) throw new Error('workSessionId is required');
  if (!principal?.id) throw new Error('Authenticated principal is required');
  const config = normalizeInstanceConfig(readConfig());
  assertCanMutate(config, 'Work session rollback');
  const history = await listBackups({ workSessionId: id, limit, committedOnly: true });
  if (!history.length) throw new Error(`Work session backup history not found: ${id}`);
  const owner = sessionOwner(history);
  const snapshots = history.filter(item => item.mutationState !== 'failed');
  if (!snapshots.length) throw new Error(`Work session has no rollback-eligible backup snapshots: ${id}`);
  const canManageOthers = principal.role === 'owner' || principal.role === 'maintainer';
  if (owner.id !== principal.id) {
    if (!canManageOthers) throw new Error(`Work session ${id} belongs to ${owner.name}`);
    if (!force) throw new Error(`Rollback of another principal's work session requires force=true: ${id}`);
  }

  const workspaceIds = [...new Set(snapshots.map(item => item.workspaceId).filter(Boolean))];
  if (!workspaceIds.length) throw new Error(`Work session has no rollback workspace metadata: ${id}`);
  for (const workspaceId of workspaceIds) {
    if (principal.workspaceIds?.length && !principal.workspaceIds.includes(workspaceId)) {
      throw new Error(`Principal ${principal.id} is not allowed to rollback workspace ${workspaceId}`);
    }
    assertWorkspaceLease({ workspaceId, principal, capability: 'write', config });
  }

  const results = [];
  for (const snapshot of snapshots) {
    try {
      results.push(await rollbackSnapshot(snapshot, dryRun));
    } catch (error) {
      results.push({
        backupId: snapshot.id,
        action: snapshot.action,
        failed: true,
        error: String(error?.message || error),
        code: error?.code || null
      });
    }
  }
  await audit('work_session_rollback', {
    principalId: principal.id,
    targetWorkSessionId: id,
    dryRun,
    force,
    snapshotCount: snapshots.length,
    failedSnapshotsSkipped: history.length - snapshots.length,
    resultCount: results.length,
    workspaces: workspaceIds
  }, { workSessionId: id });
  return {
    workSessionId: id, dryRun, force, snapshots: snapshots.length,
    failedSnapshotsSkipped: history.length - snapshots.length, results
  };
}

export const __test = {
  ROLLBACK_ACTIONS,
  rollbackEntries,
  rollbackSnapshot,
  sessionOwner
};
