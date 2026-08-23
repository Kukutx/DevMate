'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { cleanOperationId } = require('./path-policy.js');

const DEFAULT_MAX_RECORD_BYTES = 12 * 1024 * 1024;
const DEFAULT_RECORD_QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RECORD_QUARANTINE_FILES = 64;
const DEFAULT_MAX_RECORD_QUARANTINE_BYTES = 64 * 1024 * 1024;

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

function pruneRecordQuarantine(directory, {
  retentionMs = DEFAULT_RECORD_QUARANTINE_RETENTION_MS,
  maxFiles = DEFAULT_MAX_RECORD_QUARANTINE_FILES,
  maxBytes = DEFAULT_MAX_RECORD_QUARANTINE_BYTES
} = {}, nowMs = Date.now()) {
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    return { beforeFiles: 0, afterFiles: 0, beforeBytes: 0, afterBytes: 0, deleted: [] };
  }
  const artifacts = fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.json\.corrupt-/.test(entry.name) && !entry.name.includes('.replace-'))
    .map(entry => {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat?.isFile() ? { file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.file.localeCompare(right.file));
  const beforeFiles = artifacts.length;
  const beforeBytes = artifacts.reduce((sum, item) => sum + item.sizeBytes, 0);
  const cutoff = nowMs - Math.max(1, Number(retentionMs) || DEFAULT_RECORD_QUARANTINE_RETENTION_MS);
  const fileLimit = Math.max(1, Number(maxFiles) || DEFAULT_MAX_RECORD_QUARANTINE_FILES);
  const byteLimit = Math.max(1, Number(maxBytes) || DEFAULT_MAX_RECORD_QUARANTINE_BYTES);
  const deleted = [];
  const remaining = [];

  const remove = (artifact, reason) => {
    try {
      fs.rmSync(artifact.file, { force: true });
      deleted.push({ path: artifact.file, reason, sizeBytes: artifact.sizeBytes });
      return true;
    } catch {
      return false;
    }
  };

  for (const artifact of artifacts) {
    if (artifact.mtimeMs < cutoff) {
      if (!remove(artifact, 'age')) remaining.push(artifact);
    } else {
      remaining.push(artifact);
    }
  }

  let totalBytes = remaining.reduce((sum, item) => sum + item.sizeBytes, 0);
  while (remaining.length > fileLimit || totalBytes > byteLimit) {
    const artifact = remaining[0];
    if (!artifact) break;
    const reason = remaining.length > fileLimit ? 'count' : 'size';
    if (!remove(artifact, reason)) break;
    remaining.shift();
    totalBytes -= artifact.sizeBytes;
  }

  return {
    beforeFiles,
    afterFiles: remaining.length,
    beforeBytes,
    afterBytes: totalBytes,
    deleted
  };
}

function parseRecordFile(file, maxBytes = DEFAULT_MAX_RECORD_BYTES) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('Invalid record');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid record');
  return parsed;
}

function recordReplacementCandidates(target) {
  const directory = path.dirname(target);
  const prefix = `${path.basename(target)}.replace-`;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => {
      const file = path.join(directory, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat ? { file, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function validRecordFile(file, maxBytes) {
  try { return !!parseRecordFile(file, maxBytes); }
  catch { return false; }
}

function recoverRecordReplacement(target, maxBytes = DEFAULT_MAX_RECORD_BYTES) {
  const candidates = recordReplacementCandidates(target);
  let current = null;
  let currentError = null;
  try { current = parseRecordFile(target, maxBytes); }
  catch (error) { currentError = error; }

  if (current) {
    for (const candidate of candidates) {
      if (!validRecordFile(candidate.file, maxBytes)) continue;
      try { fs.rmSync(candidate.file, { force: true }); } catch {}
    }
    return current;
  }

  const replacement = candidates.find(candidate => validRecordFile(candidate.file, maxBytes));
  if (!replacement) {
    if (currentError) throw currentError;
    return null;
  }

  if (fs.existsSync(target)) {
    fs.renameSync(target, `${target}.corrupt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  }
  fs.renameSync(replacement.file, target);
  try { fs.chmodSync(target, 0o600); } catch {}
  fsyncDirectory(path.dirname(target));
  pruneRecordQuarantine(path.dirname(target));
  return parseRecordFile(target, maxBytes);
}

function atomicWriteRecord(target, record, maxBytes = DEFAULT_MAX_RECORD_BYTES) {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  recoverRecordReplacement(target, maxBytes);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Buffer.byteLength(payload, 'utf8');
  if (bytes > maxBytes) throw new Error(`Record exceeds the ${maxBytes} byte limit (${bytes} bytes)`);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temporary, target);
    } catch (error) {
      if (process.platform !== 'win32' || !fs.existsSync(target)) throw error;
      const previous = `${target}.replace-${process.pid}-${Date.now()}`;
      fs.renameSync(target, previous);
      try {
        fs.renameSync(temporary, target);
        fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(target) && fs.existsSync(previous)) {
          try { fs.renameSync(previous, target); } catch {}
        }
        throw replacementError;
      }
    }
    try { fs.chmodSync(target, 0o600); } catch {}
    fsyncDirectory(directory);
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

class JsonRecordStore {
  constructor({ stateDirectory, relativeDirectory, idPrefix, maxRecords = 200, maxRecordBytes = DEFAULT_MAX_RECORD_BYTES }) {
    this.directory = path.join(stateDirectory, relativeDirectory);
    this.idPrefix = idPrefix;
    this.maxRecords = maxRecords;
    this.maxRecordBytes = maxRecordBytes;
  }

  createId() {
    return `${this.idPrefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  }

  file(id) {
    return path.join(this.directory, `${cleanOperationId(id, this.idPrefix)}.json`);
  }

  write(record) {
    if (!record?.id) throw new Error('Record ID is required');
    const target = this.file(record.id);
    atomicWriteRecord(target, record, this.maxRecordBytes);
    this.prune();
    return record;
  }

  read(id) {
    const target = this.file(id);
    const parsed = recoverRecordReplacement(target, this.maxRecordBytes) || parseRecordFile(target, this.maxRecordBytes);
    if (!parsed) throw new Error('Invalid record');
    return parsed;
  }

  list(limit = 50) {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        try { return this.read(entry.name.slice(0, -5)); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')))
      .slice(0, Math.max(1, Math.min(this.maxRecords, Number(limit) || 50)));
  }

  prune() {
    if (!fs.existsSync(this.directory)) return;
    const records = fs.readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => {
        const file = path.join(this.directory, entry.name);
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (!stat) return null;
        let createdAtMs = 0;
        try { createdAtMs = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).createdAt || 0) || 0; }
        catch {}
        return { file, mtimeMs: stat.mtimeMs, createdAtMs };
      })
      .filter(Boolean)
      .sort((left, right) =>
        right.createdAtMs - left.createdAtMs || right.mtimeMs - left.mtimeMs || right.file.localeCompare(left.file)
      );
    for (const stale of records.slice(this.maxRecords)) {
      try { fs.rmSync(stale.file, { force: true }); } catch {}
    }
    pruneRecordQuarantine(this.directory);
  }
}

module.exports = {
  DEFAULT_MAX_RECORD_BYTES,
  DEFAULT_MAX_RECORD_QUARANTINE_BYTES,
  DEFAULT_MAX_RECORD_QUARANTINE_FILES,
  DEFAULT_RECORD_QUARANTINE_RETENTION_MS,
  JsonRecordStore,
  atomicWriteRecord,
  pruneRecordQuarantine,
  recoverRecordReplacement
};
