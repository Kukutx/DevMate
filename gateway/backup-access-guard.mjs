import { backupEntry } from './backup-store.mjs';
import { registerToolDecorator } from './server-extension-host.mjs';
import { isSensitiveWorkspacePath, sensitiveWorkspacePathReason } from './sensitive-path-policy.mjs';

function protectedError(rel, context = 'Backup path') {
  const error = new Error(`${context} is protected by DevMate credential policy: ${rel}`);
  error.code = 'sensitive_workspace_path';
  error.reason = sensitiveWorkspacePathReason(rel);
  return error;
}

async function assertBackupAccess(backupId, entryPath = '') {
  const source = await backupEntry(String(backupId || ''), String(entryPath || ''));
  if (isSensitiveWorkspacePath(source.entry.originalPath)) {
    throw protectedError(source.entry.originalPath, 'Backup source path');
  }
  return source;
}

function filterBackupList(result) {
  const backups = result?.structuredContent?.backups;
  if (!Array.isArray(backups)) return result;
  let omitted = 0;
  result.structuredContent.backups = backups.filter(item => {
    const entries = Array.isArray(item?.entries) ? item.entries : [];
    const blocked = !entries.length || entries.some(entry => !entry?.originalPath || isSensitiveWorkspacePath(entry.originalPath));
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
            await assertBackupAccess(args.backupId, args.entryPath);
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
  assertBackupAccess,
  filterBackupList
};
