'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECOVERY_RETENTION_DAYS = 30;
const DEFAULT_MAX_RECOVERY_FILES = 64;
const DEFAULT_MAX_RECOVERY_BYTES = 64 * 1024 * 1024;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function matchesAny(name, matchers) {
  return matchers.some(matcher => {
    if (!(matcher instanceof RegExp)) throw new TypeError('Recovery artifact matchers must be regular expressions');
    matcher.lastIndex = 0;
    return matcher.test(name);
  });
}

function recoveryArtifacts(directory, matchers = []) {
  const root = path.resolve(String(directory || ''));
  if (!root || !matchers.length || !fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .filter(entry => !entry.name.includes('.replace-'))
    .filter(entry => matchesAny(entry.name, matchers))
    .map(entry => {
      const file = path.join(root, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat?.isFile() ? { name: entry.name, file, mtimeMs: stat.mtimeMs, sizeBytes: stat.size } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
}

function removeArtifact(root, artifact, reason, deleted) {
  const target = path.resolve(artifact.file);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Refusing to prune recovery artifact outside its directory: ${artifact.file}`);
  }
  fs.rmSync(target, { force: true });
  deleted.push({ path: target, reason, sizeBytes: artifact.sizeBytes });
}

function pruneRecoveryArtifacts(directory, {
  matchers = [],
  retentionDays = DEFAULT_RECOVERY_RETENTION_DAYS,
  maxFiles = DEFAULT_MAX_RECOVERY_FILES,
  maxBytes = DEFAULT_MAX_RECOVERY_BYTES
} = {}, nowMs = Date.now()) {
  const root = path.resolve(String(directory || ''));
  const retention = positiveInteger(retentionDays, DEFAULT_RECOVERY_RETENTION_DAYS);
  const fileLimit = positiveInteger(maxFiles, DEFAULT_MAX_RECOVERY_FILES);
  const byteLimit = positiveInteger(maxBytes, DEFAULT_MAX_RECOVERY_BYTES);
  const artifacts = recoveryArtifacts(root, matchers);
  const beforeFiles = artifacts.length;
  const beforeBytes = artifacts.reduce((sum, item) => sum + item.sizeBytes, 0);
  const cutoff = nowMs - retention * DAY_MS;
  const deleted = [];
  const remaining = [];

  for (const artifact of artifacts) {
    if (artifact.mtimeMs < cutoff) removeArtifact(root, artifact, 'age', deleted);
    else remaining.push(artifact);
  }

  let totalBytes = remaining.reduce((sum, item) => sum + item.sizeBytes, 0);
  while (remaining.length > fileLimit || totalBytes > byteLimit) {
    const artifact = remaining.shift();
    if (!artifact) break;
    const reason = remaining.length + 1 > fileLimit ? 'count' : 'size';
    removeArtifact(root, artifact, reason, deleted);
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

module.exports = {
  DAY_MS,
  DEFAULT_MAX_RECOVERY_BYTES,
  DEFAULT_MAX_RECOVERY_FILES,
  DEFAULT_RECOVERY_RETENTION_DAYS,
  matchesAny,
  pruneRecoveryArtifacts,
  recoveryArtifacts
};
