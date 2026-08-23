'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { withFileLockSync } = require('../config-file-lock.cjs');

const OAUTH_SECRET_VERSION = 1;
const MAX_SECRET_BYTES = 64 * 1024;

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function oauthSecretsPath(configFile) {
  const file = path.resolve(String(configFile || ''));
  if (!file) throw new Error('OAuth secret storage requires a config file');
  return path.join(path.dirname(file), 'state', 'oauth-secrets.json');
}

function ensureDirectory(file) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OAuth secret document must be an object');
  if (value.version !== OAUTH_SECRET_VERSION) throw new Error(`Unsupported OAuth secret version: ${String(value.version)}`);
  const signingKey = String(value.signingKey || '').trim();
  const ownerApprovalCode = String(value.ownerApprovalCode || '').trim();
  if (signingKey.length < 43 || ownerApprovalCode.length < 24) throw new Error('OAuth secret document is incomplete');
  const generation = Number(value.generation);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('OAuth secret generation is invalid');
  return {
    version: OAUTH_SECRET_VERSION,
    signingKey,
    ownerApprovalCode,
    generation,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null
  };
}

function parseDocument(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.size > MAX_SECRET_BYTES) throw new Error('OAuth secret storage is invalid');
  return normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
}

function readDocument(file, { required = true } = {}) {
  const value = parseDocument(file);
  if (!value) {
    if (!required) return null;
    const error = new Error('OAuth secrets are not initialized for this DevMate instance');
    error.code = 'oauth_secrets_missing';
    throw error;
  }
  try { fs.chmodSync(file, 0o600); } catch {}
  return value;
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

function replacementCandidates(file) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.replace-`;
  if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => {
      const candidate = path.join(directory, entry.name);
      const stat = fs.statSync(candidate, { throwIfNoEntry: false });
      return stat ? { file: candidate, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function validReplacement(file) {
  try { return !!parseDocument(file); }
  catch { return false; }
}

function cleanupValidReplacements(candidates, except = '') {
  for (const candidate of candidates) {
    if (candidate.file === except || !validReplacement(candidate.file)) continue;
    try { fs.rmSync(candidate.file, { force: true }); } catch {}
  }
}

function recoverOAuthSecretsReplacement(file) {
  ensureDirectory(file);
  const candidates = replacementCandidates(file);
  let current = null;
  let currentError = null;
  try { current = parseDocument(file); }
  catch (error) { currentError = error; }

  if (current) {
    cleanupValidReplacements(candidates);
    try { fs.chmodSync(file, 0o600); } catch {}
    return current;
  }

  const replacement = candidates.find(candidate => validReplacement(candidate.file));
  if (!replacement) {
    if (currentError) throw currentError;
    return null;
  }

  if (fs.existsSync(file)) {
    const corrupt = `${file}.corrupt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    fs.renameSync(file, corrupt);
  }
  fs.renameSync(replacement.file, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  fsyncDirectory(path.dirname(file));
  cleanupValidReplacements(candidates, replacement.file);
  return readDocument(file);
}

function atomicWrite(file, document) {
  const normalized = normalizeDocument(document);
  ensureDirectory(file);
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(payload, 'utf8') > MAX_SECRET_BYTES) throw new Error('OAuth secret storage exceeds its size bound');
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${file}.replace-${process.pid}-${Date.now()}`;
      let moved = false;
      try {
        if (fs.existsSync(file)) {
          fs.renameSync(file, previous);
          moved = true;
        }
        fs.renameSync(tmp, file);
        if (moved) fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(file) && moved && fs.existsSync(previous)) {
          try { fs.renameSync(previous, file); } catch {}
        }
        throw replacementError;
      }
    }
    try { fs.chmodSync(file, 0o600); } catch {}
    fsyncDirectory(path.dirname(file));
  } finally {
    if (fd != null) try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  return normalized;
}

function freshDocument() {
  return {
    version: OAUTH_SECRET_VERSION,
    signingKey: randomSecret(32),
    ownerApprovalCode: randomSecret(18),
    generation: 1,
    updatedAt: new Date().toISOString()
  };
}

function ensureOAuthSecrets(configFile) {
  const file = oauthSecretsPath(configFile);
  ensureDirectory(file);
  return withFileLockSync(file, () => {
    const existing = recoverOAuthSecretsReplacement(file);
    if (existing) return existing;
    return atomicWrite(file, freshDocument());
  });
}

function readOAuthSecrets(configFile) {
  const file = oauthSecretsPath(configFile);
  ensureDirectory(file);
  return withFileLockSync(file, () => {
    const recovered = recoverOAuthSecretsReplacement(file);
    if (!recovered) return readDocument(file);
    return recovered;
  });
}

function rotateOwnerApprovalCode(configFile, expectedCode) {
  const file = oauthSecretsPath(configFile);
  return withFileLockSync(file, () => {
    const current = recoverOAuthSecretsReplacement(file) || readDocument(file);
    const expected = Buffer.from(String(expectedCode || ''), 'utf8');
    const actual = Buffer.from(current.ownerApprovalCode, 'utf8');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      const error = new Error('The OAuth owner approval code has already been used or replaced');
      error.code = 'oauth_approval_code_stale';
      throw error;
    }
    const next = {
      ...current,
      ownerApprovalCode: randomSecret(18),
      generation: current.generation + 1,
      updatedAt: new Date().toISOString()
    };
    return atomicWrite(file, next);
  });
}

module.exports = {
  MAX_SECRET_BYTES,
  OAUTH_SECRET_VERSION,
  ensureOAuthSecrets,
  oauthSecretsPath,
  readOAuthSecrets,
  recoverOAuthSecretsReplacement,
  rotateOwnerApprovalCode
};
