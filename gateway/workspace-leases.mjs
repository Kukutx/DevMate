import crypto from 'node:crypto';
import {
  mutateDurableDocument,
  readDurableNamespace
} from './durable-state.mjs';

export const WORKSPACE_LEASE_NAMESPACE = 'workspace-leases';
const NAMESPACE = WORKSPACE_LEASE_NAMESPACE;
const leases = new Map();

function nowIso(now = Date.now()) { return new Date(now).toISOString(); }
function roleCanForce(role) { return role === 'owner' || role === 'maintainer'; }

function leaseMap(values) {
  return new Map((Array.isArray(values) ? values : [])
    .filter(item => item?.workspaceId)
    .map(item => [item.workspaceId, item]));
}

function documentLeaseMap(document) {
  return leaseMap(document?.namespaces?.[NAMESPACE]);
}

function writeDocumentLeases(document, values) {
  document.namespaces ||= {};
  document.namespaces[NAMESPACE] = [...values];
}

function pruneLeaseMap(values, now = Date.now()) {
  let changed = false;
  for (const [workspaceId, lease] of values) {
    if (Date.parse(lease.expiresAt) <= now) {
      values.delete(workspaceId);
      changed = true;
    }
  }
  return changed;
}

export function syncWorkspaceLeasesFromDurableState() {
  const next = leaseMap(readDurableNamespace(NAMESPACE, []));
  leases.clear();
  for (const [workspaceId, lease] of next) leases.set(workspaceId, lease);
  return leases;
}

export function workspaceLeaseInDocument(document, workspaceId, now = Date.now()) {
  const values = documentLeaseMap(document);
  pruneLeaseMap(values, now);
  writeDocumentLeases(document, values.values());
  const lease = values.get(String(workspaceId || ''));
  return lease ? { ...lease } : null;
}

export function acquireWorkspaceLeaseInDocument(document, {
  workspaceId,
  principal,
  ttlSeconds = 1800,
  purpose = '',
  force = false,
  now = Date.now()
}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw new Error('workspaceId is required');
  if (!principal?.id) throw new Error('Authenticated principal is required');
  const values = documentLeaseMap(document);
  pruneLeaseMap(values, now);
  const current = values.get(id);
  if (current && current.principalId !== principal.id && !(force && roleCanForce(principal.role))) {
    throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId} until ${current.expiresAt}`);
  }
  const ttl = Math.min(24 * 60 * 60, Math.max(60, Math.trunc(Number(ttlSeconds) || 1800)));
  const samePrincipal = current?.principalId === principal.id;
  const timestamp = nowIso(now);
  const lease = {
    id: samePrincipal ? current.id : `lease-${crypto.randomBytes(8).toString('hex')}`,
    workspaceId: id,
    principalId: principal.id,
    principalName: principal.name || principal.id,
    principalRole: principal.role,
    purpose: String(purpose || '').trim().slice(0, 500),
    acquiredAt: samePrincipal ? current.acquiredAt : timestamp,
    renewedAt: timestamp,
    expiresAt: new Date(now + ttl * 1000).toISOString()
  };
  values.set(id, lease);
  writeDocumentLeases(document, values.values());
  return { ...lease };
}

export function releaseWorkspaceLeaseInDocument(document, {
  workspaceId,
  principal,
  force = false,
  now = Date.now()
}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw new Error('workspaceId is required');
  const values = documentLeaseMap(document);
  pruneLeaseMap(values, now);
  const current = values.get(id);
  if (!current) {
    writeDocumentLeases(document, values.values());
    return { released: false, workspaceId: id, reason: 'not leased' };
  }
  if (current.principalId !== principal?.id && !(force && roleCanForce(principal?.role))) {
    throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId}`);
  }
  values.delete(id);
  writeDocumentLeases(document, values.values());
  return { released: true, lease: { ...current } };
}

syncWorkspaceLeasesFromDurableState();

export function pruneWorkspaceLeases(now = Date.now()) {
  mutateDurableDocument(document => {
    const values = documentLeaseMap(document);
    pruneLeaseMap(values, now);
    writeDocumentLeases(document, values.values());
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
}

export function listWorkspaceLeases() {
  pruneWorkspaceLeases();
  return [...leases.values()].map(lease => ({ ...lease }));
}

export function workspaceLease(workspaceId) {
  pruneWorkspaceLeases();
  const lease = leases.get(String(workspaceId || ''));
  return lease ? { ...lease } : null;
}

export function acquireWorkspaceLease(options) {
  let lease = null;
  mutateDurableDocument(document => {
    lease = acquireWorkspaceLeaseInDocument(document, options);
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return lease;
}

export function releaseWorkspaceLease(options) {
  let result = null;
  mutateDurableDocument(document => {
    result = releaseWorkspaceLeaseInDocument(document, options);
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return result;
}

export function assertWorkspaceLease({ workspaceId, principal, capability, config }) {
  if (!workspaceId || !config?.team?.requireWorkspaceLeaseForWrites) return null;
  if (!['write', 'execute', 'git', 'publish'].includes(capability)) return null;
  if (principal?.source === 'local') return null;
  pruneWorkspaceLeases();
  const current = leases.get(workspaceId);
  if (!current) throw new Error(`Workspace ${workspaceId} requires a lease before ${capability} operations`);
  if (current.principalId !== principal?.id) {
    throw new Error(`Workspace ${workspaceId} is leased by ${current.principalName || current.principalId}`);
  }
  return { ...current };
}

export function clearWorkspaceLeases() {
  mutateDurableDocument(document => {
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = [];
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
}

export const __test = {
  acquireWorkspaceLeaseInDocument,
  documentLeaseMap,
  leases,
  pruneLeaseMap,
  releaseWorkspaceLeaseInDocument,
  roleCanForce,
  syncWorkspaceLeasesFromDurableState,
  writeDocumentLeases
};