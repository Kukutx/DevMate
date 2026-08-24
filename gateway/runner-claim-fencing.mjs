import crypto from 'node:crypto';
import { now } from './local-shared.mjs';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';
import { releaseExternalJobWorkspaceHold } from './external-job-workspace-holds.mjs';

const NAMESPACE = 'runner-claims';
const VERSION = 1;
const TOKEN_BYTES = 32;
const MAX_CLAIMS = 5000;
const GENERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function emptyStore() {
  return { version: VERSION, claims: {}, generations: {} };
}

function claimStateError(message, detail = {}) {
  const error = new Error(`Runner claim durable state is invalid: ${message}`);
  error.code = 'runner_claim_state_invalid';
  error.status = 409;
  Object.assign(error, detail);
  return error;
}

function claimCapacityError(count) {
  const error = new Error(`Runner claim capacity reached (${count}/${MAX_CLAIMS})`);
  error.code = 'runner_claim_capacity';
  error.status = 409;
  error.count = count;
  error.limit = MAX_CLAIMS;
  return error;
}

function validTime(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeClaim(jobId, record) {
  if (!validId(jobId) || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw claimStateError(`claim ${String(jobId || '(empty)')} must be an object`, { jobId: jobId || null });
  }
  if (record.jobId !== jobId || !validId(record.runnerId)) {
    throw claimStateError(`claim ${jobId} has inconsistent identity`, { jobId });
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
    throw claimStateError(`claim ${jobId} has an invalid generation`, { jobId });
  }
  if (typeof record.tokenHash !== 'string' || !TOKEN_HASH_PATTERN.test(record.tokenHash)) {
    throw claimStateError(`claim ${jobId} has an invalid token hash`, { jobId });
  }
  if (!validTime(record.issuedAt) || !validTime(record.leaseExpiresAt)) {
    throw claimStateError(`claim ${jobId} has invalid timestamps`, { jobId });
  }
  return { ...record };
}

function normalizeGeneration(jobId, record) {
  if (!validId(jobId) || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw claimStateError(`generation ${String(jobId || '(empty)')} must be an object`, { jobId: jobId || null });
  }
  if (!Number.isSafeInteger(record.generation) || record.generation < 1 || !validTime(record.updatedAt)) {
    throw claimStateError(`generation ${jobId} is invalid`, { jobId });
  }
  return { generation: record.generation, updatedAt: record.updatedAt };
}

export function normalizeRunnerClaimStore(value) {
  if (value === undefined) return emptyStore();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw claimStateError('root must be an object');
  if (value.version !== VERSION) throw claimStateError(`unsupported version ${String(value.version)}`, { stateVersion: value.version ?? null });
  if (!value.claims || typeof value.claims !== 'object' || Array.isArray(value.claims)) throw claimStateError('claims must be an object');
  if (!value.generations || typeof value.generations !== 'object' || Array.isArray(value.generations)) throw claimStateError('generations must be an object');

  const claims = Object.fromEntries(Object.entries(value.claims).map(([jobId, record]) => [jobId, normalizeClaim(jobId, record)]));
  const generations = Object.fromEntries(Object.entries(value.generations).map(([jobId, record]) => [jobId, normalizeGeneration(jobId, record)]));
  for (const [jobId, claim] of Object.entries(claims)) {
    const retained = generations[jobId];
    if (!retained || retained.generation < claim.generation) {
      throw claimStateError(`claim ${jobId} is missing a matching retained generation`, { jobId, claimGeneration: claim.generation });
    }
  }
  return { version: VERSION, claims, generations };
}

function readStore() {
  return normalizeRunnerClaimStore(readDurableNamespace(NAMESPACE, emptyStore()));
}

function writeStore(store) {
  return writeDurableNamespace(NAMESPACE, normalizeRunnerClaimStore(store));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('base64url');
}

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function claimError(message, code = 'claim_fence_invalid') {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function prune(store, at = Date.now()) {
  for (const [jobId, claim] of Object.entries(store.claims)) {
    const expires = Date.parse(claim.leaseExpiresAt);
    if (expires < at - 5 * 60 * 1000) delete store.claims[jobId];
  }
  if (Object.keys(store.claims).length > MAX_CLAIMS) throw claimCapacityError(Object.keys(store.claims).length);

  for (const [jobId, generation] of Object.entries(store.generations)) {
    const updated = Date.parse(generation.updatedAt);
    if (!store.claims[jobId] && updated < at - GENERATION_RETENTION_MS) delete store.generations[jobId];
  }
  const generations = Object.entries(store.generations);
  if (generations.length > MAX_CLAIMS) {
    const removable = generations
      .filter(([jobId]) => !store.claims[jobId])
      .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
    const removeCount = generations.length - MAX_CLAIMS;
    if (removable.length < removeCount) throw claimCapacityError(Object.keys(store.claims).length);
    removable.slice(0, removeCount).forEach(([jobId]) => delete store.generations[jobId]);
  }
  return store;
}

function claimRecord(store, jobId) {
  return store.claims[String(jobId || '').trim()] || null;
}

function generationValue(store, jobId) {
  const active = Number(claimRecord(store, jobId)?.generation) || 0;
  const retained = Number(store.generations?.[jobId]?.generation) || 0;
  return Math.max(active, retained);
}

function validateRecord(record, { jobId, runnerId, generation, token, allowExpired = false }) {
  if (!record) throw claimError(`No active Runner claim exists for job ${jobId}`);
  if (record.runnerId !== runnerId) throw claimError(`Runner ${runnerId} does not own claim for job ${jobId}`);
  if (!Number.isInteger(generation) || generation < 1 || !String(token || '')) {
    throw claimError(`Runner claim proof is required for job ${jobId}`, 'claim_fence_proof_required');
  }
  if (Number(record.generation) !== generation) throw claimError(`Runner claim generation is stale for job ${jobId}`);
  if (!timingSafeEqualText(record.tokenHash, hashToken(token))) throw claimError(`Runner claim token is invalid for job ${jobId}`);
  if (!allowExpired && Date.parse(record.leaseExpiresAt || 0) <= Date.now()) {
    throw claimError(`Runner claim has expired for job ${jobId}`, 'claim_fence_expired');
  }
  return record;
}

function releaseWorkspaceHoldBestEffort(jobId, runnerId) {
  try {
    return releaseExternalJobWorkspaceHold({ jobId, runnerId });
  } catch {
    // Claim fencing is the execution authority. A cleanup-store failure must not
    // turn an already-completed job into an ambiguous failed response. The hold
    // itself is bounded and remains fail-closed until expiry/retry.
    return false;
  }
}

export function issueRunnerClaimInStore(storeValue, { jobId, runnerId, leaseExpiresAt }) {
  const id = String(jobId || '').trim();
  const owner = String(runnerId || '').trim();
  if (!id || !owner) throw new Error('Runner claim requires jobId and runnerId');
  const expires = Date.parse(leaseExpiresAt || '');
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Runner claim requires a future leaseExpiresAt');
  const store = prune(normalizeRunnerClaimStore(storeValue));
  if (!store.claims[id] && Object.keys(store.claims).length >= MAX_CLAIMS) throw claimCapacityError(Object.keys(store.claims).length);
  const generation = generationValue(store, id) + 1;
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const issuedAt = now();
  store.claims[id] = {
    jobId: id,
    runnerId: owner,
    generation,
    tokenHash: hashToken(token),
    issuedAt,
    leaseExpiresAt: new Date(expires).toISOString()
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
}

export function activeRunnerClaim(jobId, runnerId = '') {
  const id = String(jobId || '').trim();
  if (!id) return null;
  const store = prune(readStore());
  const record = claimRecord(store, id);
  if (!record || Date.parse(record.leaseExpiresAt || 0) <= Date.now()) return null;
  if (runnerId && record.runnerId !== String(runnerId)) return null;
  return {
    jobId: record.jobId,
    runnerId: record.runnerId,
    generation: record.generation,
    leaseExpiresAt: record.leaseExpiresAt
  };
}

export function validateRunnerClaim(input) {
  const store = prune(readStore());
  const record = validateRecord(claimRecord(store, input.jobId), input);
  return { generation: record.generation, runnerId: record.runnerId, leaseExpiresAt: record.leaseExpiresAt };
}

export function renewRunnerClaim(input) {
  const store = prune(readStore());
  const record = validateRecord(claimRecord(store, input.jobId), input);
  const expires = Date.parse(input.leaseExpiresAt || '');
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Runner claim renewal requires a future leaseExpiresAt');
  record.leaseExpiresAt = new Date(expires).toISOString();
  store.generations[input.jobId] = { generation: record.generation, updatedAt: now() };
  writeStore(store);
  return { generation: record.generation, leaseExpiresAt: record.leaseExpiresAt };
}

export function consumeRunnerClaim(input) {
  const store = prune(readStore());
  const record = validateRecord(claimRecord(store, input.jobId), { ...input, allowExpired: true });
  delete store.claims[input.jobId];
  store.generations[input.jobId] = { generation: record.generation, updatedAt: now() };
  writeStore(store);
  const workspaceHoldReleased = releaseWorkspaceHoldBestEffort(input.jobId, record.runnerId);
  return { generation: record.generation, runnerId: record.runnerId, workspaceHoldReleased };
}

export function revokeRunnerClaim(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return false;
  const store = readStore();
  const record = store.claims[id];
  if (!record) {
    releaseWorkspaceHoldBestEffort(id, '');
    return false;
  }
  delete store.claims[id];
  store.generations[id] = { generation: record.generation, updatedAt: now() };
  writeStore(store);
  releaseWorkspaceHoldBestEffort(id, record.runnerId);
  return true;
}

export function runnerClaimStatus() {
  const store = prune(readStore());
  writeStore(store);
  return {
    version: VERSION,
    active: Object.values(store.claims).map(claim => ({
      jobId: claim.jobId,
      runnerId: claim.runnerId,
      generation: claim.generation,
      issuedAt: claim.issuedAt,
      leaseExpiresAt: claim.leaseExpiresAt
    })),
    retainedGenerations: Object.keys(store.generations).length
  };
}

export function clearRunnerClaimsForTests() {
  writeStore(emptyStore());
}

export const __test = {
  GENERATION_RETENTION_MS,
  MAX_CLAIMS,
  TOKEN_BYTES,
  TOKEN_HASH_PATTERN,
  claimCapacityError,
  claimStateError,
  emptyStore,
  generationValue,
  hashToken,
  normalizeClaim,
  normalizeGeneration,
  normalizeRunnerClaimStore,
  prune,
  releaseWorkspaceHoldBestEffort,
  timingSafeEqualText,
  validateRecord
};