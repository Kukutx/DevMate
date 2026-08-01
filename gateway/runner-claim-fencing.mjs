import crypto from 'node:crypto';
import { now } from './local-shared.mjs';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';

const NAMESPACE = 'runner-claims';
const VERSION = 1;
const TOKEN_BYTES = 32;
const MAX_CLAIMS = 5000;
const GENERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function emptyStore() {
  return { version: VERSION, claims: {}, generations: {} };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
  return {
    version: VERSION,
    claims: value.claims && typeof value.claims === 'object' && !Array.isArray(value.claims)
      ? { ...value.claims }
      : {},
    generations: value.generations && typeof value.generations === 'object' && !Array.isArray(value.generations)
      ? { ...value.generations }
      : {}
  };
}

function readStore() {
  return normalizeStore(readDurableNamespace(NAMESPACE, emptyStore()));
}

function writeStore(store) {
  return writeDurableNamespace(NAMESPACE, normalizeStore(store));
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
    const expires = Date.parse(claim?.leaseExpiresAt || 0);
    if (!Number.isFinite(expires) || expires < at - 5 * 60 * 1000) delete store.claims[jobId];
  }
  for (const [jobId, generation] of Object.entries(store.generations)) {
    const updated = Date.parse(generation?.updatedAt || 0);
    if (!store.claims[jobId] && (!Number.isFinite(updated) || updated < at - GENERATION_RETENTION_MS)) {
      delete store.generations[jobId];
    }
  }
  const claims = Object.entries(store.claims);
  if (claims.length > MAX_CLAIMS) {
    claims
      .sort((a, b) => Date.parse(a[1]?.issuedAt || 0) - Date.parse(b[1]?.issuedAt || 0))
      .slice(0, claims.length - MAX_CLAIMS)
      .forEach(([jobId]) => delete store.claims[jobId]);
  }
  const generations = Object.entries(store.generations);
  if (generations.length > MAX_CLAIMS) {
    generations
      .filter(([jobId]) => !store.claims[jobId])
      .sort((a, b) => Date.parse(a[1]?.updatedAt || 0) - Date.parse(b[1]?.updatedAt || 0))
      .slice(0, Math.max(0, generations.length - MAX_CLAIMS))
      .forEach(([jobId]) => delete store.generations[jobId]);
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

function validateRecord(record, {
  jobId,
  runnerId,
  generation,
  token,
  allowExpired = false,
  allowLegacyFirst = false
}) {
  if (!record) throw claimError(`No active Runner claim exists for job ${jobId}`);
  if (record.runnerId !== runnerId) throw claimError(`Runner ${runnerId} does not own claim for job ${jobId}`);
  const missingProof = generation == null && !String(token || '');
  if (!(allowLegacyFirst && missingProof && Number(record.generation) === 1)) {
    if (Number(record.generation) !== Number(generation)) throw claimError(`Runner claim generation is stale for job ${jobId}`);
    if (!timingSafeEqualText(record.tokenHash, hashToken(token))) throw claimError(`Runner claim token is invalid for job ${jobId}`);
  }
  if (!allowExpired && Date.parse(record.leaseExpiresAt || 0) <= Date.now()) {
    throw claimError(`Runner claim has expired for job ${jobId}`, 'claim_fence_expired');
  }
  return record;
}

export function issueRunnerClaim({ jobId, runnerId, leaseExpiresAt }) {
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
}

export function validateRunnerClaim(input) {
  const store = prune(readStore());
  const record = validateRecord(claimRecord(store, input.jobId), input);
  return { generation: record.generation, runnerId: record.runnerId, leaseExpiresAt: record.leaseExpiresAt };
}

export function renewRunnerClaim(input) {
  const store = prune(readStore());
  const record = validateRecord(claimRecord(store, input.jobId), input);
  record.leaseExpiresAt = new Date(input.leaseExpiresAt).toISOString();
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
  return { generation: record.generation, runnerId: record.runnerId };
}

export function revokeRunnerClaim(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return false;
  const store = readStore();
  const record = store.claims[id];
  if (!record) return false;
  delete store.claims[id];
  store.generations[id] = { generation: Number(record.generation) || generationValue(store, id), updatedAt: now() };
  writeStore(store);
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
  emptyStore,
  generationValue,
  hashToken,
  normalizeStore,
  prune,
  timingSafeEqualText,
  validateRecord
};
