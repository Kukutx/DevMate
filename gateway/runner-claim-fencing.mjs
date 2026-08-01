import crypto from 'node:crypto';
import { now } from './local-shared.mjs';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';

const NAMESPACE = 'runner-claims';
const VERSION = 1;
const TOKEN_BYTES = 32;
const MAX_CLAIMS = 5000;

function emptyStore() {
  return { version: VERSION, claims: {} };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
  return {
    version: VERSION,
    claims: value.claims && typeof value.claims === 'object' && !Array.isArray(value.claims)
      ? { ...value.claims }
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
  const entries = Object.entries(store.claims);
  for (const [jobId, claim] of entries) {
    const expires = Date.parse(claim?.leaseExpiresAt || 0);
    if (!Number.isFinite(expires) || expires < at - 5 * 60 * 1000) delete store.claims[jobId];
  }
  const remaining = Object.entries(store.claims);
  if (remaining.length > MAX_CLAIMS) {
    remaining
      .sort((a, b) => Date.parse(a[1]?.issuedAt || 0) - Date.parse(b[1]?.issuedAt || 0))
      .slice(0, remaining.length - MAX_CLAIMS)
      .forEach(([jobId]) => delete store.claims[jobId]);
  }
  return store;
}

function claimRecord(store, jobId) {
  return store.claims[String(jobId || '').trim()] || null;
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
  const previous = claimRecord(store, id);
  const generation = Math.max(0, Math.trunc(Number(previous?.generation) || 0)) + 1;
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  store.claims[id] = {
    jobId: id,
    runnerId: owner,
    generation,
    tokenHash: hashToken(token),
    issuedAt: now(),
    leaseExpiresAt: new Date(leaseExpiresAt).toISOString()
  };
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
  writeStore(store);
  return { generation: record.generation, leaseExpiresAt: record.leaseExpiresAt };
}

export function consumeRunnerClaim(input) {
  const store = prune(readStore());
  const record = validateRecord(claimRecord(store, input.jobId), { ...input, allowExpired: true });
  delete store.claims[input.jobId];
  writeStore(store);
  return { generation: record.generation, runnerId: record.runnerId };
}

export function revokeRunnerClaim(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return false;
  const store = readStore();
  if (!Object.hasOwn(store.claims, id)) return false;
  delete store.claims[id];
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
    }))
  };
}

export function clearRunnerClaimsForTests() {
  writeStore(emptyStore());
}

export const __test = { MAX_CLAIMS, TOKEN_BYTES, emptyStore, hashToken, normalizeStore, prune, timingSafeEqualText, validateRecord };
