import { mutateDurableDocument, readDurableNamespace } from './durable-state.mjs';
import { releaseWorkspaceLeaseHold } from './workspace-leases.mjs';

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

export function rememberExternalJobWorkspaceHold({ jobId, runnerId, hold }) {
  const id = String(jobId || '').trim();
  const runner = String(runnerId || '').trim();
  if (!id || !runner || !hold?.id || !hold?.leaseId || !hold?.workspaceId || !hold?.principalId) {
    throw new Error('External job workspace hold requires jobId, runnerId, and a complete lease hold');
  }
  let record = null;
  mutateDurableDocument(document => {
    const store = prune(normalizeStore(document.namespaces?.[NAMESPACE]));
    const existing = store.records[id];
    if (existing && existing.runnerId !== runner) {
      throw new Error(`External job ${id} workspace hold belongs to runner ${existing.runnerId}`);
    }
    record = {
      jobId: id,
      runnerId: runner,
      hold: {
        id: String(hold.id),
        leaseId: String(hold.leaseId),
        workspaceId: String(hold.workspaceId),
        principalId: String(hold.principalId),
        expiresAt: String(hold.expiresAt || '')
      },
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    store.records[id] = record;
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = store;
    return document;
  });
  return JSON.parse(JSON.stringify(record));
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
  const record = externalJobWorkspaceHold(jobId);
  if (!record || (runnerId && record.runnerId !== String(runnerId))) return false;
  const released = releaseWorkspaceLeaseHold({
    workspaceId: record.hold.workspaceId,
    holdId: record.hold.id,
    leaseId: record.hold.leaseId,
    principalId: record.hold.principalId
  });
  forgetExternalJobWorkspaceHold({ jobId, runnerId: record.runnerId });
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
  normalizeStore,
  prune
};
