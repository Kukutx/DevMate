import { mutateDurableDocument, readDurableNamespace } from './durable-state.mjs';
import {
  acquireWorkspaceLeaseHoldInDocument,
  releaseWorkspaceLeaseHoldInDocument,
  syncWorkspaceLeasesFromDurableState
} from './workspace-leases.mjs';

const NAMESPACE = 'external-job-workspace-holds';
const VERSION = 1;
const MAX_RECORDS = 5000;

function emptyStore() {
  return { version: VERSION, records: {} };
}

function stateError(message, detail = {}) {
  const error = new Error(`External job workspace-hold durable state is invalid: ${message}`);
  error.code = 'external_job_workspace_hold_state_invalid';
  Object.assign(error, detail);
  return error;
}

function capacityError(count) {
  const error = new Error(`External job workspace-hold capacity reached (${count}/${MAX_RECORDS})`);
  error.code = 'external_job_workspace_hold_capacity';
  error.count = count;
  error.limit = MAX_RECORDS;
  return error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeRecord(jobId, record) {
  if (!nonEmpty(jobId) || !record || typeof record !== 'object' || Array.isArray(record)) {
    throw stateError(`record ${String(jobId || '(empty)')} must be an object with a non-empty job id`, { jobId: jobId || null });
  }
  if (record.jobId !== jobId || !nonEmpty(record.runnerId)) {
    throw stateError(`record ${jobId} has inconsistent identity`, { jobId });
  }
  if (!record.hold || typeof record.hold !== 'object' || Array.isArray(record.hold)) {
    throw stateError(`record ${jobId} is missing its workspace hold`, { jobId });
  }
  for (const field of ['id', 'leaseId', 'workspaceId', 'principalId']) {
    if (!nonEmpty(record.hold[field])) throw stateError(`record ${jobId} has invalid hold.${field}`, { jobId });
  }
  if (!validTimestamp(record.hold.expiresAt)) throw stateError(`record ${jobId} has invalid hold expiry`, { jobId });
  if (!validTimestamp(record.createdAt) || !validTimestamp(record.updatedAt)) {
    throw stateError(`record ${jobId} has invalid timestamps`, { jobId });
  }
  return {
    ...record,
    hold: { ...record.hold }
  };
}

function normalizeStore(value) {
  if (value == null) return emptyStore();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw stateError('root must be an object');
  if (value.version !== VERSION) throw stateError(`unsupported version ${String(value.version)}`, { stateVersion: value.version ?? null });
  if (!value.records || typeof value.records !== 'object' || Array.isArray(value.records)) throw stateError('records must be an object');
  const records = {};
  for (const [jobId, record] of Object.entries(value.records)) records[jobId] = normalizeRecord(jobId, record);
  return { version: VERSION, records };
}

function prune(store, now = Date.now()) {
  for (const [jobId, record] of Object.entries(store.records)) {
    if (Date.parse(record.hold.expiresAt) <= now) delete store.records[jobId];
  }
  const count = Object.keys(store.records).length;
  if (count > MAX_RECORDS) throw capacityError(count);
  return store;
}

export function externalJobWorkspaceHold(jobId) {
  const id = String(jobId || '').trim();
  if (!id) return null;
  const store = prune(normalizeStore(readDurableNamespace(NAMESPACE, emptyStore())));
  const record = store.records[id];
  return record ? JSON.parse(JSON.stringify(record)) : null;
}

function holdRecord(id, runner, hold) {
  const timestamp = new Date().toISOString();
  return {
    jobId: id,
    runnerId: runner,
    hold: {
      id: String(hold.id),
      leaseId: String(hold.leaseId),
      workspaceId: String(hold.workspaceId),
      principalId: String(hold.principalId),
      expiresAt: String(hold.expiresAt || '')
    },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function holdConflict(id, existingRunner = '') {
  const error = new Error(existingRunner
    ? `External job ${id} already has a workspace hold for runner ${existingRunner}`
    : `External job ${id} already has a workspace hold`);
  error.code = 'external_job_workspace_hold_conflict';
  return error;
}

export function acquireExternalJobWorkspaceHold({
  jobId,
  runnerId,
  workspaceId,
  principal,
  capability,
  config,
  holdMs = null,
  purpose = ''
}) {
  const id = String(jobId || '').trim();
  const runner = String(runnerId || '').trim();
  if (!id || !runner) throw new Error('External job workspace hold requires jobId and runnerId');
  let hold = null;
  let record = null;
  mutateDurableDocument(document => {
    const store = prune(normalizeStore(document.namespaces?.[NAMESPACE]));
    const existing = store.records[id];
    if (existing) throw holdConflict(id, existing.runnerId || '');
    if (Object.keys(store.records).length >= MAX_RECORDS) throw capacityError(Object.keys(store.records).length);

    hold = acquireWorkspaceLeaseHoldInDocument(document, {
      workspaceId,
      principal,
      capability,
      config,
      holdMs,
      purpose
    });
    if (hold) {
      record = holdRecord(id, runner, hold);
      store.records[id] = record;
    }
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = store;
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return {
    hold: hold ? JSON.parse(JSON.stringify(hold)) : null,
    record: record ? JSON.parse(JSON.stringify(record)) : null
  };
}

export function forgetExternalJobWorkspaceHold({ jobId, runnerId = '' }) {
  const id = String(jobId || '').trim();
  if (!id) return false;
  let removed = false;
  mutateDurableDocument(document => {
    const store = prune(normalizeStore(document.namespaces?.[NAMESPACE]));
    const record = store.records[id];
    if (record && (!runnerId || record.runnerId === String(runnerId))) {
      delete store.records[id];
      removed = true;
    }
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = store;
    return document;
  });
  return removed;
}

export function releaseExternalJobWorkspaceHold({ jobId, runnerId = '' }) {
  const id = String(jobId || '').trim();
  if (!id) return false;
  let released = false;
  mutateDurableDocument(document => {
    const store = prune(normalizeStore(document.namespaces?.[NAMESPACE]));
    const record = store.records[id];
    if (!record || (runnerId && record.runnerId !== String(runnerId))) {
      document.namespaces ||= {};
      document.namespaces[NAMESPACE] = store;
      return document;
    }
    released = releaseWorkspaceLeaseHoldInDocument(document, {
      workspaceId: record.hold.workspaceId,
      holdId: record.hold.id,
      leaseId: record.hold.leaseId,
      principalId: record.hold.principalId
    });
    if (released) delete store.records[id];
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = store;
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return released;
}

export function clearExternalJobWorkspaceHoldsForTests() {
  mutateDurableDocument(document => {
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = emptyStore();
    return document;
  });
}

export const __test = {
  MAX_RECORDS,
  NAMESPACE,
  VERSION,
  capacityError,
  emptyStore,
  holdRecord,
  normalizeRecord,
  normalizeStore,
  prune,
  stateError
};