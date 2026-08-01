#!/usr/bin/env node
// One-time branch migration. Removed before merge after its generated commit is verified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patch(relativePath, transforms) {
  const file = path.join(root, relativePath);
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to, description] of transforms) {
    if (!text.includes(from)) throw new Error(`${relativePath}: missing patch anchor for ${description}`);
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text, 'utf8');
}

patch('gateway/local-shared.mjs', [
  [
    "import crypto from 'node:crypto';\n",
    "import crypto from 'node:crypto';\nimport { createRequire } from 'node:module';\n\nconst require = createRequire(import.meta.url);\nconst { withFileLockSync } = require('../config-file-lock.cjs');\n",
    'shared config lock import'
  ],
  [
    'export const MAX_AUDIT_ENTRY_BYTES = 64 * 1024;\n',
    'export const MAX_AUDIT_ENTRY_BYTES = 64 * 1024;\nexport const MAX_CONFIG_BYTES = 16 * 1024 * 1024;\n',
    'config size limit'
  ],
  [
`function validConfigFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, ''));
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}`,
`function validConfigFile(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_CONFIG_BYTES) return false;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, ''));
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}`,
    'bounded config recovery validation'
  ],
  [
`    recoverConfigReplacement();
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\\uFEFF/, '');`,
`    recoverConfigReplacement();
    const stat = fs.statSync(CONFIG_PATH, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error('configuration file does not exist');
    if (stat.size > MAX_CONFIG_BYTES) {
      const error = new Error(\`configuration exceeds the ${MAX_CONFIG_BYTES} byte limit\`);
      error.code = 'config_too_large';
      throw error;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\\uFEFF/, '');`,
    'config read size check'
  ],
  [
`  } catch (error) {
    throw new Error(\`Could not read DevMate config ${CONFIG_PATH}: ${error.message || error}\`);
  }
}

export function writeConfig(config, { force = false } = {}) {`,
`  } catch (error) {
    const wrapped = new Error(\`Could not read DevMate config ${CONFIG_PATH}: ${error.message || error}\`);
    if (error?.code) wrapped.code = error.code;
    throw wrapped;
  }
}

function writeConfigUnlocked(config, { force = false } = {}) {`,
    'config errors and unlocked writer'
  ],
  [
`  const payload = \`${JSON.stringify(config, null, 2)}\\n\`;
  const temporary =`,
`  const payload = \`${JSON.stringify(config, null, 2)}\\n\`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_CONFIG_BYTES) {
    const error = new Error(\`DevMate config exceeds the ${MAX_CONFIG_BYTES} byte limit (${payloadBytes} bytes)\`);
    error.code = 'config_too_large';
    throw error;
  }
  const temporary =`,
    'config write size check'
  ],
  [
`export function mutateConfig(mutator, { retries = 3 } = {}) {
  if (typeof mutator !== 'function') throw new TypeError('Config mutator must be a function');
  const attempts = Math.min(10, Math.max(1, Math.trunc(Number(retries) || 3)));
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = readConfig();
    const changed = mutator(current);
    if (changed && typeof changed.then === 'function') throw new TypeError('Config mutator must be synchronous');
    const next = changed === undefined ? current : changed;
    try {
      return writeConfig(next);
    } catch (error) {
      if (error?.code !== 'config_conflict' || attempt === attempts - 1) throw error;
      lastError = error;
    }
  }
  throw lastError || configConflict('DevMate config could not be updated because it kept changing');
}`,
`export function writeConfig(config, options = {}) {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return withFileLockSync(CONFIG_PATH, () => writeConfigUnlocked(config, options));
}

export function mutateConfig(mutator, { retries = 3 } = {}) {
  if (typeof mutator !== 'function') throw new TypeError('Config mutator must be a function');
  return withFileLockSync(CONFIG_PATH, () => {
    const attempts = Math.min(10, Math.max(1, Math.trunc(Number(retries) || 3)));
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = readConfig();
      const changed = mutator(current);
      if (changed && typeof changed.then === 'function') throw new TypeError('Config mutator must be synchronous');
      if (changed === false) return current;
      const next = changed === undefined ? current : changed;
      try {
        return writeConfigUnlocked(next);
      } catch (error) {
        if (error?.code !== 'config_conflict' || attempt === attempts - 1) throw error;
        lastError = error;
      }
    }
    throw lastError || configConflict('DevMate config could not be updated because it kept changing');
  });
}`,
    'transactional config mutation'
  ]
]);

patch('extension-config-io.js', [
  [
    "const crypto = require('crypto');\n",
    "const crypto = require('crypto');\nconst { withFileLockSync } = require('./config-file-lock.cjs');\n\nconst MAX_CONFIG_BYTES = 16 * 1024 * 1024;\n",
    'extension config lock import'
  ],
  [
`function parseJsonValue(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');`,
`function parseJsonValue(value) {
  const bytes = Buffer.isBuffer(value) ? value.length : Buffer.byteLength(String(value || ''), 'utf8');
  if (bytes > MAX_CONFIG_BYTES) {
    const error = new Error(\`DevMate config exceeds the ${MAX_CONFIG_BYTES} byte limit (${bytes} bytes)\`);
    error.code = 'config_too_large';
    throw error;
  }
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');`,
    'extension config parse bound'
  ],
  [
`function recoverReplacement(fsModule, file) {
  const candidates = replacementCandidates(fsModule, file);
  if (fsModule.existsSync(file)) {
    for (const candidate of candidates) {
      try { fsModule.rmSync(candidate.file, { force: true }); } catch {}
    }
    return null;
  }
  const candidate = candidates[0];
  if (!candidate) return null;`,
`function validConfigFile(fsModule, file) {
  try {
    const stat = fsModule.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_CONFIG_BYTES) return false;
    parseJsonValue(fsModule.readFileSync(file, 'utf8'));
    return true;
  } catch { return false; }
}

function recoverReplacement(fsModule, file) {
  const candidates = replacementCandidates(fsModule, file);
  if (fsModule.existsSync(file) && validConfigFile(fsModule, file)) {
    for (const candidate of candidates) {
      try { fsModule.rmSync(candidate.file, { force: true }); } catch {}
    }
    return null;
  }
  const candidate = candidates.find(item => validConfigFile(fsModule, item.file));
  if (!candidate) return null;
  if (fsModule.existsSync(file)) {
    try { fsModule.renameSync(file, \`${file}.corrupt-${Date.now()}\`); }
    catch { try { fsModule.rmSync(file, { force: true }); } catch {} }
  }`,
    'extension recovery validation'
  ],
  [
`  const payload = \`${JSON.stringify(value, null, 2)}\\n\`;
  const temporary =`,
`  const payload = \`${JSON.stringify(value, null, 2)}\\n\`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_CONFIG_BYTES) {
    const error = new Error(\`DevMate config exceeds the ${MAX_CONFIG_BYTES} byte limit (${payloadBytes} bytes)\`);
    error.code = 'config_too_large';
    throw error;
  }
  const temporary =`,
    'extension config write bound'
  ],
  [
`function writeMergedExtensionConfig(fsModule, file, candidateValue) {
  const candidate = object(candidateValue);
  const current = readCurrent(fsModule, file);
  const merged = mergeExtensionConfig(current, candidate);
  atomicWriteJson(fsModule, file, merged);
  return merged;
}`,
`function writeMergedExtensionConfig(fsModule, file, candidateValue) {
  return withFileLockSync(file, () => {
    const candidate = object(candidateValue);
    const current = readCurrent(fsModule, file);
    const merged = mergeExtensionConfig(current, candidate);
    atomicWriteJson(fsModule, file, merged);
    return merged;
  });
}`,
    'extension transactional merge'
  ],
  [
`    const candidate = parseJsonValue(data);
    const current = readCurrent(fsModule, targetPath);
    atomicWriteJson(fsModule, targetPath, mergeExtensionConfig(current, candidate), originalWriteFileSync);`,
`    const candidate = parseJsonValue(data);
    withFileLockSync(targetPath, () => {
      const current = readCurrent(fsModule, targetPath);
      atomicWriteJson(fsModule, targetPath, mergeExtensionConfig(current, candidate), originalWriteFileSync);
    });`,
    'extension proxy lock'
  ],
  [
`  atomicWriteJson,
  createConfigFsProxy,`,
`  MAX_CONFIG_BYTES,
  atomicWriteJson,
  createConfigFsProxy,`,
    'extension config limit export'
  ]
]);

patch('gateway/durable-state.mjs', [
  [
    'export const DOCUMENT_VERSION = 1;\n',
    'export const DOCUMENT_VERSION = 1;\nexport const MAX_DURABLE_STATE_BYTES = 128 * 1024 * 1024;\n',
    'durable size limit'
  ],
  [
`export function recoverDurableStateReplacement() {
  if (!RUNTIME_STATE_PATH || !STATE_ROOT || !fs.existsSync(STATE_ROOT)) return null;
  const candidates = replacementCandidates();
  if (fs.existsSync(RUNTIME_STATE_PATH)) {
    for (const candidate of candidates) {
      try { fs.rmSync(candidate.file, { force: true }); } catch {}
    }
    return null;
  }
  const candidate = candidates[0];
  if (!candidate) return null;`,
`function validDurableFile(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_DURABLE_STATE_BYTES) return false;
    normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, '')));
    return true;
  } catch (error) {
    return error?.code === 'unsupported_state_version';
  }
}

export function recoverDurableStateReplacement() {
  if (!RUNTIME_STATE_PATH || !STATE_ROOT || !fs.existsSync(STATE_ROOT)) return null;
  const candidates = replacementCandidates();
  if (fs.existsSync(RUNTIME_STATE_PATH) && validDurableFile(RUNTIME_STATE_PATH)) {
    for (const candidate of candidates) {
      try { fs.rmSync(candidate.file, { force: true }); } catch {}
    }
    return null;
  }
  const candidate = candidates.find(item => validDurableFile(item.file));
  if (!candidate) return null;
  if (fs.existsSync(RUNTIME_STATE_PATH)) {
    try { fs.renameSync(RUNTIME_STATE_PATH, \`${RUNTIME_STATE_PATH}.corrupt-${Date.now()}\`); }
    catch { try { fs.rmSync(RUNTIME_STATE_PATH, { force: true }); } catch {} }
  }`,
    'durable recovery validation'
  ],
  [
`  try {
    cache = normalizeDocument(JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8').replace(/^\\uFEFF/, '')));`,
`  try {
    const stat = fs.statSync(RUNTIME_STATE_PATH, { throwIfNoEntry: false });
    if (stat?.size > MAX_DURABLE_STATE_BYTES) {
      const error = new Error(\`DevMate durable state exceeds the ${MAX_DURABLE_STATE_BYTES} byte limit (${stat.size} bytes)\`);
      error.code = 'durable_state_too_large';
      throw error;
    }
    cache = normalizeDocument(JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8').replace(/^\\uFEFF/, '')));`,
    'durable read bound'
  ],
  [
`    if (error?.code === 'unsupported_state_version') throw error;`,
`    if (['unsupported_state_version', 'durable_state_too_large'].includes(error?.code)) throw error;`,
    'durable protected errors'
  ],
  [
`  const payload = \`${JSON.stringify(normalized, null, 2)}\\n\`;
  let fd = null;`,
`  const payload = \`${JSON.stringify(normalized, null, 2)}\\n\`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_DURABLE_STATE_BYTES) {
    const error = new Error(\`DevMate durable state exceeds the ${MAX_DURABLE_STATE_BYTES} byte limit (${payloadBytes} bytes)\`);
    error.code = 'durable_state_too_large';
    throw error;
  }
  let fd = null;`,
    'durable write bound'
  ],
  [
`export function readDurableNamespace(name, fallback) {`,
`export function mutateDurableDocument(mutator) {
  if (typeof mutator !== 'function') throw new TypeError('Durable document mutator must be a function');
  const document = clone(readDocument());
  const result = mutator(document);
  if (result && typeof result.then === 'function') throw new TypeError('Durable document mutator must be synchronous');
  atomicWrite(document);
  return clone(result);
}

export function readDurableNamespace(name, fallback) {`,
    'atomic durable document mutation'
  ],
  [
`  atomicWrite,
  emptyDocument,`,
`  atomicWrite,
  emptyDocument,
  validDurableFile,`,
    'durable test export'
  ]
]);

patch('gateway/runner-claim-fencing.mjs', [
  [
    'function normalizeStore(value) {',
    'export function normalizeRunnerClaimStore(value) {',
    'claim store normalization export'
  ],
  [
    'return normalizeStore(readDurableNamespace(NAMESPACE, emptyStore()));',
    'return normalizeRunnerClaimStore(readDurableNamespace(NAMESPACE, emptyStore()));',
    'claim store reader'
  ],
  [
    'return writeDurableNamespace(NAMESPACE, normalizeStore(store));',
    'return writeDurableNamespace(NAMESPACE, normalizeRunnerClaimStore(store));',
    'claim store writer'
  ],
  [
`export function issueRunnerClaim({ jobId, runnerId, leaseExpiresAt }) {
  const id = String(jobId || '').trim();
  const owner = String(runnerId || '').trim();
  if (!id || !owner) throw new Error('Runner claim requires jobId and runnerId');
  const store = prune(readStore());
  const generation = generationValue(store, id) + 1;
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const issuedAt = now();
  store.claims[id] = {
    jobId: id,
    runnerId: owner,
    generation,
    tokenHash: hashToken(token),
    issuedAt,
    leaseExpiresAt: new Date(leaseExpiresAt).toISOString()
  };
  store.generations[id] = { generation, updatedAt: issuedAt };
  writeStore(store);
  return { generation, token };
}`,
`export function issueRunnerClaimInStore(storeValue, { jobId, runnerId, leaseExpiresAt }) {
  const id = String(jobId || '').trim();
  const owner = String(runnerId || '').trim();
  if (!id || !owner) throw new Error('Runner claim requires jobId and runnerId');
  const store = prune(normalizeRunnerClaimStore(storeValue));
  const generation = generationValue(store, id) + 1;
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const issuedAt = now();
  store.claims[id] = {
    jobId: id,
    runnerId: owner,
    generation,
    tokenHash: hashToken(token),
    issuedAt,
    leaseExpiresAt: new Date(leaseExpiresAt).toISOString()
  };
  store.generations[id] = { generation, updatedAt: issuedAt };
  Object.assign(storeValue, store);
  return { generation, token };
}

export function issueRunnerClaim(input) {
  const store = readStore();
  const claim = issueRunnerClaimInStore(store, input);
  writeStore(store);
  return claim;
}`,
    'pure claim issuance'
  ],
  [
    'normalizeStore,\n',
    'normalizeRunnerClaimStore,\n',
    'claim test export'
  ]
]);

patch('gateway/runner-control-plane.mjs', [
  [
    "import { preflightQueuedJob } from './job-preflight.mjs';\n",
    "import { preflightQueuedJob } from './job-preflight.mjs';\nimport { claimExternalJob } from './external-job-claim.mjs';\n",
    'atomic external claim import'
  ],
  [
    '  claimJob,\n',
    '',
    'remove non-atomic claim import'
  ],
  [
    '  issueRunnerClaim,\n',
    '',
    'remove separate fence import'
  ],
  [
`  if (pathName === \`${PREFIX}/jobs/claim\`) {
    const job = claimJob({ runnerId: principal.id, leaseSeconds: body.leaseSeconds });
    if (!job) return json(res, 200, { runner, job: null }, requestId);
    try {
      preflightQueuedJob(job);
      const claim = issueRunnerClaim({
        jobId: job.id,
        runnerId: principal.id,
        leaseExpiresAt: job.leaseExpiresAt
      });
      return json(res, 200, { runner, job: executionEnvelope(job, claim) }, requestId);
    } catch (error) {`,
`  if (pathName === \`${PREFIX}/jobs/claim\`) {
    const claimed = claimExternalJob({ runnerId: principal.id, leaseSeconds: body.leaseSeconds });
    const job = claimed?.job || null;
    if (!job) return json(res, 200, { runner, job: null }, requestId);
    try {
      preflightQueuedJob(job);
      return json(res, 200, { runner, job: executionEnvelope(job, claimed.claim) }, requestId);
    } catch (error) {
      try { revokeRunnerClaim(job.id); } catch {}`, 
    'atomic claim and fence route'
  ]
]);

console.log('Applied final DevMate maintenance hardening patches.');
