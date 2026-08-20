import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import maintenanceConfig from '../shared/maintenance-config.cjs';
import { withAuditLogLock } from './audit-log-coordinator.mjs';
import { withStartupStage } from './startup-progress.mjs';

const { DEFAULT_MAINTENANCE, MAINTENANCE_LIMITS } = maintenanceConfig;
const DAY_MS = 24 * 60 * 60 * 1000;

export { DEFAULT_MAINTENANCE };

export function clampMaintenanceNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function maintenanceOptions(input = {}) {
  const [backupDaysMin, backupDaysMax] = MAINTENANCE_LIMITS.backupRetentionDays;
  const [auditDaysMin, auditDaysMax] = MAINTENANCE_LIMITS.auditRetentionDays;
  const [backupBytesMin, backupBytesMax] = MAINTENANCE_LIMITS.maxBackupBytes;
  const [auditBytesMin, auditBytesMax] = MAINTENANCE_LIMITS.maxAuditBytes;
  return {
    backupRetentionDays: clampMaintenanceNumber(input.backupRetentionDays, DEFAULT_MAINTENANCE.backupRetentionDays, backupDaysMin, backupDaysMax),
    auditRetentionDays: clampMaintenanceNumber(input.auditRetentionDays, DEFAULT_MAINTENANCE.auditRetentionDays, auditDaysMin, auditDaysMax),
    maxBackupBytes: clampMaintenanceNumber(input.maxBackupBytes, DEFAULT_MAINTENANCE.maxBackupBytes, backupBytesMin, backupBytesMax),
    maxAuditBytes: clampMaintenanceNumber(input.maxAuditBytes, DEFAULT_MAINTENANCE.maxAuditBytes, auditBytesMin, auditBytesMax)
  };
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch { return null; }
}

async function lstatOrNull(file) {
  try { return await fsp.lstat(file); } catch { return null; }
}

async function directoryStats(root) {
  const st = await lstatOrNull(root);
  if (!st) return { bytes: 0, files: 0 };
  if (!st.isDirectory()) return { bytes: st.size, files: 1 };

  let bytes = st.size;
  let files = 0;
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return { bytes, files }; }
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryStats(child);
      bytes += nested.bytes;
      files += nested.files;
      continue;
    }
    const childStat = await lstatOrNull(child);
    bytes += childStat?.size || 0;
    files += 1;
  }
  return { bytes, files };
}

async function safeRemoveChild(root, target) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  if (targetPath === rootPath || !isInside(rootPath, targetPath)) {
    throw new Error(`Refusing to remove path outside maintenance root: ${target}`);
  }
  await fsp.rm(targetPath, { recursive: true, force: true });
}

async function listBackupSets(backupRoot) {
  let entries = [];
  try { entries = await fsp.readdir(backupRoot, { withFileTypes: true }); } catch { return []; }
  const sets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(backupRoot, entry.name);
    const st = await statOrNull(full);
    if (!st) continue;
    const stats = await directoryStats(full);
    sets.push({
      name: entry.name,
      path: full,
      mtimeMs: st.mtimeMs,
      sizeBytes: stats.bytes,
      fileCount: stats.files
    });
  }
  sets.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return sets;
}

export async function stateSummary(paths) {
  const backupSets = await listBackupSets(paths.backupRoot);
  const auditStat = await statOrNull(paths.auditLog);
  let auditEntries = 0;
  try {
    const text = await fsp.readFile(paths.auditLog, 'utf8');
    auditEntries = text.split(/\r?\n/).filter(Boolean).length;
  } catch {}
  return {
    backupSets: backupSets.length,
    backupFiles: backupSets.reduce((sum, item) => sum + item.fileCount, 0),
    backupBytes: backupSets.reduce((sum, item) => sum + item.sizeBytes, 0),
    auditEntries,
    auditBytes: auditStat?.size || 0
  };
}

export async function pruneBackups(backupRoot, options = {}, nowMs = Date.now()) {
  const opts = maintenanceOptions(options);
  await fsp.mkdir(backupRoot, { recursive: true });
  const sets = await listBackupSets(backupRoot);
  const beforeBytes = sets.reduce((sum, item) => sum + item.sizeBytes, 0);
  const beforeSets = sets.length;
  const cutoff = nowMs - opts.backupRetentionDays * DAY_MS;
  const deleted = [];
  const remaining = [];

  for (const item of sets) {
    if (item.mtimeMs < cutoff) {
      await safeRemoveChild(backupRoot, item.path);
      deleted.push({ path: item.path, reason: 'age', sizeBytes: item.sizeBytes });
    } else {
      remaining.push(item);
    }
  }

  let total = remaining.reduce((sum, item) => sum + item.sizeBytes, 0);
  let firstKept = 0;
  while (total > opts.maxBackupBytes && firstKept < remaining.length) {
    const item = remaining[firstKept++];
    await safeRemoveChild(backupRoot, item.path);
    total -= item.sizeBytes;
    deleted.push({ path: item.path, reason: 'size', sizeBytes: item.sizeBytes });
  }

  return {
    beforeSets,
    afterSets: remaining.length - firstKept,
    beforeBytes,
    afterBytes: total,
    deleted
  };
}

async function pruneAuditLogUnlocked(auditLog, options = {}, nowMs = Date.now()) {
  const opts = maintenanceOptions(options);
  const stat = await statOrNull(auditLog);
  if (!stat) return { beforeEntries: 0, afterEntries: 0, beforeBytes: 0, afterBytes: 0, removedEntries: 0, changed: false };
  const original = await fsp.readFile(auditLog, 'utf8');
  const lines = original.split(/\r?\n/).filter(Boolean);
  const cutoff = nowMs - opts.auditRetentionDays * DAY_MS;
  let kept = lines.filter(line => {
    try {
      const t = Date.parse(JSON.parse(line).time || '');
      return !Number.isFinite(t) || t >= cutoff;
    } catch {
      return true;
    }
  });

  let totalBytes = 0;
  let firstKept = kept.length;
  while (firstKept > 0) {
    const bytes = Buffer.byteLength(kept[firstKept - 1], 'utf8') + 1;
    if (totalBytes + bytes > opts.maxAuditBytes) break;
    totalBytes += bytes;
    firstKept -= 1;
  }
  if (firstKept) kept = kept.slice(firstKept);

  const next = kept.length ? `${kept.join('\n')}\n` : '';
  const changed = next !== original;
  if (changed) {
    await fsp.mkdir(path.dirname(auditLog), { recursive: true });
    const tmp = `${auditLog}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, next, { encoding: 'utf8', mode: 0o600 });
      try { await fsp.chmod(tmp, 0o600); } catch {}
      await fsp.rename(tmp, auditLog);
      try { await fsp.chmod(auditLog, 0o600); } catch {}
    } finally {
      try { await fsp.rm(tmp, { force: true }); } catch {}
    }
  }
  return {
    beforeEntries: lines.length,
    afterEntries: kept.length,
    beforeBytes: stat.size,
    afterBytes: totalBytes,
    removedEntries: lines.length - kept.length,
    changed
  };
}

export function pruneAuditLog(auditLog, options = {}, nowMs = Date.now()) {
  return withAuditLogLock(auditLog, () => pruneAuditLogUnlocked(auditLog, options, nowMs));
}

export function pruneState(paths, options = {}, nowMs = Date.now()) {
  return withStartupStage('maintenance', async () => {
    await fsp.mkdir(paths.stateRoot, { recursive: true });
    await fsp.mkdir(paths.backupRoot, { recursive: true });
    const opts = maintenanceOptions(options);
    const backups = await pruneBackups(paths.backupRoot, opts, nowMs);
    const audit = await pruneAuditLog(paths.auditLog, opts, nowMs);
    return { options: opts, backups, audit };
  });
}
