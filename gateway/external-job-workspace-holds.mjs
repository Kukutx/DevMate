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

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyStore();
  const records = value.records && typeof value.records === 'object' && !Array.isArray(value.records)
    ? { ...value.records }
    : {};
  return { version: VERSION, records };
}

function prune(store, now = Date.now()) {
  for (const [jobId, record] of Object.entries(store.records)) {
    const expiresAt = Date.parse(record?.hold?.expiresAt || '');
    if (!record?.hold?.id || !record?.runnerId || !Number.isFinite(expiresAt) || expiresAt <= now) {
      delete store.records[jobId];
    }
  }
  const entries = Object.entries(store.records);
  if (entries.length > MAX_RECORDS) {
    entries
      .sort(([, left], [, right]) => Date.parse(left?.createdAt || 0) - Date.parse(right?.createdAt || 0))
      .slice(0, entries.length - MAX_RECORDS)
      .forEach(([jobId]) => { delete store.records[jobId]; });
  }
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
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
  emptyStore,
  holdRecord,
  normalizeStore,
  prune
};
