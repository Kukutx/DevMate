import crypto from 'node:crypto';
import {
  mutateDurableDocument,
  readDurableNamespace
} from './durable-state.mjs';

export const WORKSPACE_LEASE_NAMESPACE = 'workspace-leases';
export const WORKSPACE_LEASE_HOLD_MIN_MS = 60 * 1000;
export const WORKSPACE_LEASE_HOLD_MAX_MS = 2 * 60 * 60 * 1000;
const NAMESPACE = WORKSPACE_LEASE_NAMESPACE;
const leases = new Map();

function nowIso(now = Date.now()) { return new Date(now).toISOString(); }
function roleCanForce(role) { return role === 'owner' || role === 'maintainer'; }

function leaseRequired({ workspaceId, principal, capability, config }) {
  return !!workspaceId &&
    config?.team?.requireWorkspaceLeaseForWrites === true &&
    ['write', 'execute', 'git', 'publish'].includes(capability) &&
    principal?.source !== 'local';
}

function operationHoldMs(config, requestedMs = null) {
  const configured = Math.max(
    Number(config?.requestPolicy?.requestTimeoutMs) || 0,
    Number(config?.runtime?.defaultCommandTimeoutMs) || 0,
    WORKSPACE_LEASE_HOLD_MIN_MS
  );
  const raw = requestedMs == null ? configured + 60_000 : Number(requestedMs);
  return Math.min(
    WORKSPACE_LEASE_HOLD_MAX_MS,
    Math.max(WORKSPACE_LEASE_HOLD_MIN_MS, Number.isFinite(raw) ? Math.trunc(raw) : configured + 60_000)
  );
}

function leaseHolds(lease) {
  return Array.isArray(lease?.operationHolds) ? lease.operationHolds : [];
}

function pruneLeaseHolds(lease, now = Date.now()) {
  const before = leaseHolds(lease);
  const next = before.filter(hold =>
    hold?.id && hold?.principalId && Number.isFinite(Date.parse(hold.expiresAt || '')) && Date.parse(hold.expiresAt) > now
  );
  lease.operationHolds = next;
  return next.length !== before.length;
}

function activeHoldUntil(lease) {
  let latest = 0;
  for (const hold of leaseHolds(lease)) latest = Math.max(latest, Date.parse(hold.expiresAt || '') || 0);
  return latest ? new Date(latest).toISOString() : null;
}

function publicLease(lease) {
  if (!lease) return null;
  const { operationHolds: _holds, ...value } = lease;
  const activeOperations = leaseHolds(lease).length;
  return {
    ...value,
    activeOperations,
    heldUntil: activeHoldUntil(lease)
  };
}

function leaseMap(values) {
  return new Map((Array.isArray(values) ? values : [])
    .filter(item => item?.workspaceId)
    .map(item => [item.workspaceId, { ...item, operationHolds: leaseHolds(item).map(hold => ({ ...hold })) }]));
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
    if (pruneLeaseHolds(lease, now)) changed = true;
    if (Date.parse(lease.expiresAt) <= now && leaseHolds(lease).length === 0) {
      values.delete(workspaceId);
      changed = true;
    }
  }
  return changed;
}

function assertNoActiveOperations(lease) {
  const count = leaseHolds(lease).length;
  if (!count) return;
  const error = new Error(`Workspace ${lease.workspaceId} has ${count} active operation${count === 1 ? '' : 's'} under lease ${lease.id} until ${activeHoldUntil(lease)}`);
  error.code = 'workspace_lease_active_operations';
  error.workspaceId = lease.workspaceId;
  error.leaseId = lease.id;
  error.activeOperations = count;
  error.heldUntil = activeHoldUntil(lease);
  throw error;
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
  return publicLease(values.get(String(workspaceId || '')) || null);
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
  if (current && current.principalId !== principal.id) {
    if (!(force && roleCanForce(principal.role))) {
      throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId} until ${current.expiresAt}`);
    }
    assertNoActiveOperations(current);
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
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    operationHolds: samePrincipal ? leaseHolds(current).map(hold => ({ ...hold })) : []
  };
  values.set(id, lease);
  writeDocumentLeases(document, values.values());
  return publicLease(lease);
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
  assertNoActiveOperations(current);
  values.delete(id);
  writeDocumentLeases(document, values.values());
  return { released: true, lease: publicLease(current) };
}

export function acquireWorkspaceLeaseHoldInDocument(document, {
  workspaceId,
  principal,
  capability,
  config,
  holdMs = null,
  purpose = '',
  now = Date.now()
}) {
  if (!leaseRequired({ workspaceId, principal, capability, config })) return null;
  const values = documentLeaseMap(document);
  pruneLeaseMap(values, now);
  const current = values.get(String(workspaceId));
  if (!current) throw new Error(`Workspace ${workspaceId} requires a lease before ${capability} operations`);
  if (current.principalId !== principal?.id) {
    throw new Error(`Workspace ${workspaceId} is leased by ${current.principalName || current.principalId}`);
  }
  const acquiredAt = nowIso(now);
  const hold = {
    id: `hold-${crypto.randomBytes(10).toString('hex')}`,
    leaseId: current.id,
    workspaceId: current.workspaceId,
    principalId: principal.id,
    capability,
    purpose: String(purpose || '').slice(0, 200),
    acquiredAt,
    expiresAt: new Date(now + operationHoldMs(config, holdMs)).toISOString()
  };
  current.operationHolds = [...leaseHolds(current), hold];
  values.set(current.workspaceId, current);
  writeDocumentLeases(document, values.values());
  return { ...hold };
}

export function releaseWorkspaceLeaseHoldInDocument(document, {
  workspaceId,
  holdId,
  leaseId = '',
  principalId = '',
  now = Date.now()
}) {
  const id = String(workspaceId || '').trim();
  const token = String(holdId || '').trim();
  if (!id || !token) return false;
  const values = documentLeaseMap(document);
  pruneLeaseMap(values, now);
  const current = values.get(id);
  if (!current || (leaseId && current.id !== leaseId)) {
    writeDocumentLeases(document, values.values());
    return false;
  }
  const before = leaseHolds(current);
  const hold = before.find(item => item.id === token);
  if (!hold || (principalId && hold.principalId !== principalId)) {
    writeDocumentLeases(document, values.values());
    return false;
  }
  current.operationHolds = before.filter(item => item.id !== token);
  if (Date.parse(current.expiresAt) <= now && current.operationHolds.length === 0) values.delete(id);
  else values.set(id, current);
  writeDocumentLeases(document, values.values());
  return true;
}

syncWorkspaceLeasesFromDurableState();

export function pruneWorkspaceLeases(now = Date.now()) {
  const needsPrune = [...leases.values()].some(lease =>
    Date.parse(lease.expiresAt) <= now || leaseHolds(lease).some(hold => Date.parse(hold.expiresAt || '') <= now)
  );
  if (!needsPrune) return false;
  mutateDurableDocument(document => {
    const values = documentLeaseMap(document);
    pruneLeaseMap(values, now);
    writeDocumentLeases(document, values.values());
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return true;
}

export function listWorkspaceLeases() {
  pruneWorkspaceLeases();
  return [...leases.values()].map(publicLease);
}

export function workspaceLease(workspaceId) {
  pruneWorkspaceLeases();
  return publicLease(leases.get(String(workspaceId || '')) || null);
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

export function acquireWorkspaceLeaseHold(options) {
  let hold = null;
  mutateDurableDocument(document => {
    hold = acquireWorkspaceLeaseHoldInDocument(document, options);
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return hold;
}

export function releaseWorkspaceLeaseHold(options) {
  let released = false;
  mutateDurableDocument(document => {
    released = releaseWorkspaceLeaseHoldInDocument(document, options);
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return released;
}

export function assertWorkspaceLease({ workspaceId, principal, capability, config }) {
  if (!leaseRequired({ workspaceId, principal, capability, config })) return null;
  pruneWorkspaceLeases();
  const current = leases.get(workspaceId);
  if (!current) throw new Error(`Workspace ${workspaceId} requires a lease before ${capability} operations`);
  if (current.principalId !== principal?.id) {
    throw new Error(`Workspace ${workspaceId} is leased by ${current.principalName || current.principalId}`);
  }
  return publicLease(current);
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
  acquireWorkspaceLeaseHoldInDocument,
  acquireWorkspaceLeaseInDocument,
  activeHoldUntil,
  assertNoActiveOperations,
  documentLeaseMap,
  leaseRequired,
  leases,
  operationHoldMs,
  pruneLeaseHolds,
  pruneLeaseMap,
  publicLease,
  releaseWorkspaceLeaseHoldInDocument,
  releaseWorkspaceLeaseInDocument,
  roleCanForce,
  syncWorkspaceLeasesFromDurableState,
  writeDocumentLeases
};
