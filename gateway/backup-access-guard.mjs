import path from 'node:path';
import { registerToolDecorator } from './server-extension-host.mjs';
import { isSensitiveWorkspacePath, sensitiveWorkspacePathReason } from './sensitive-path-policy.mjs';

const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
const BACKUP_ROOT = CONFIG_PATH ? path.join(path.dirname(path.resolve(CONFIG_PATH)), 'state', 'backups') : '';

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function protectedError(rel, context = 'Backup path') {
  const error = new Error(`${context} is protected by DevMate credential policy: ${rel}`);
  error.code = 'sensitive_workspace_path';
  error.reason = sensitiveWorkspacePathReason(rel);
  return error;
}

function backupOriginalRelative(backupPath) {
  if (!BACKUP_ROOT) return '';
  const root = path.resolve(BACKUP_ROOT);
  const candidate = path.resolve(String(backupPath || ''));
  if (!isInside(root, candidate) || candidate === root) return '';
  const parts = path.relative(root, candidate).split(path.sep).filter(Boolean);
  if (parts.length < 2) return '';
  return parts.slice(1).join('/');
}

function assertBackupAccess(backupPath) {
  if (!BACKUP_ROOT) throw new Error('DEVMATE_CONFIG is required for backup access');
  const root = path.resolve(BACKUP_ROOT);
  const candidate = path.resolve(String(backupPath || ''));
  if (!isInside(root, candidate) || candidate === root) {
    const error = new Error('Backup path is outside DevMate backup root');
    error.code = 'backup_path_invalid';
    throw error;
  }
  const originalRel = backupOriginalRelative(candidate);
  if (!originalRel) {
    const error = new Error('Backup path does not encode an original workspace-relative path');
    error.code = 'backup_path_invalid';
    throw error;
  }
  if (isSensitiveWorkspacePath(originalRel)) throw protectedError(originalRel, 'Backup source path');
  return { backupPath: candidate, originalRel };
}

function filterBackupList(result) {
  const backups = result?.structuredContent?.backups;
  if (!Array.isArray(backups)) return result;
  let omitted = 0;
  result.structuredContent.backups = backups.filter(item => {
    const originalRel = backupOriginalRelative(item?.path);
    const blocked = !originalRel || isSensitiveWorkspacePath(originalRel);
    if (blocked) omitted += 1;
    return !blocked;
  });
  if (omitted) result.structuredContent.sensitiveBackupsOmitted = omitted;
  if (Array.isArray(result.content)) {
    const text = JSON.stringify(result.structuredContent, null, 2);
    for (const item of result.content) if (item?.type === 'text') item.text = text;
  }
  return result;
}

export function installBackupAccessGuard(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.backup-access-guard',
    order: 6.5,
    decorate({ name, handler }) {
      if (name === 'restore_backup') {
        return {
          handler: async (args = {}, ...rest) => {
            assertBackupAccess(args.backupPath);
            return handler(args, ...rest);
          }
        };
      }
      if (name === 'list_backups') {
        return {
          handler: async (args = {}, ...rest) => filterBackupList(await handler(args, ...rest))
        };
      }
      return { handler };
    }
  });
}

export const __test = {
  BACKUP_ROOT,
  assertBackupAccess,
  backupOriginalRelative,
  filterBackupList,
  isInside
};
