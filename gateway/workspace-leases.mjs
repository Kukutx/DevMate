import crypto from 'node:crypto';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';

const NAMESPACE = 'workspace-leases';
const restored = readDurableNamespace(NAMESPACE, []);
const leases = new Map((Array.isArray(restored) ? restored : [])
  .filter(item => item?.workspaceId)
  .map(item => [item.workspaceId, item]));

function nowIso() { return new Date().toISOString(); }
function roleCanForce(role) { return role === 'owner' || role === 'maintainer'; }
function persist() { writeDurableNamespace(NAMESPACE, [...leases.values()]); }

export function pruneWorkspaceLeases(now = Date.now()) {
  let changed = false;
  for (const [workspaceId, lease] of leases) {
    if (Date.parse(lease.expiresAt) <= now) {
      leases.delete(workspaceId);
      changed = true;
    }
  }
  if (changed) persist();
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

export function acquireWorkspaceLease({ workspaceId, principal, ttlSeconds = 1800, purpose = '', force = false }) {
  const id = String(workspaceId || '').trim();
  if (!id) throw new Error('workspaceId is required');
  if (!principal?.id) throw new Error('Authenticated principal is required');
  pruneWorkspaceLeases();
  const current = leases.get(id);
  if (current && current.principalId !== principal.id && !(force && roleCanForce(principal.role))) {
    throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId} until ${current.expiresAt}`);
  }
  const ttl = Math.min(24 * 60 * 60, Math.max(60, Math.trunc(Number(ttlSeconds) || 1800)));
  const now = Date.now();
  const samePrincipal = current?.principalId === principal.id;
  const lease = {
    id: samePrincipal ? current.id : `lease-${crypto.randomBytes(8).toString('hex')}`,
    workspaceId: id,
    principalId: principal.id,
    principalName: principal.name || principal.id,
    principalRole: principal.role,
    purpose: String(purpose || '').trim().slice(0, 500),
    acquiredAt: samePrincipal ? current.acquiredAt : nowIso(),
    renewedAt: nowIso(),
    expiresAt: new Date(now + ttl * 1000).toISOString()
  };
  leases.set(id, lease);
  persist();
  return { ...lease };
}

export function releaseWorkspaceLease({ workspaceId, principal, force = false }) {
  const id = String(workspaceId || '').trim();
  if (!id) throw new Error('workspaceId is required');
  pruneWorkspaceLeases();
  const current = leases.get(id);
  if (!current) return { released: false, workspaceId: id, reason: 'not leased' };
  if (current.principalId !== principal?.id && !(force && roleCanForce(principal?.role))) {
    throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId}`);
  }
  leases.delete(id);
  persist();
  return { released: true, lease: current };
}

export function assertWorkspaceLease({ workspaceId, principal, capability, config }) {
  if (!workspaceId || !config?.team?.enabled || !config.team.requireWorkspaceLeaseForWrites) return null;
  if (!['write', 'execute', 'git', 'publish'].includes(capability)) return null;
  if (principal?.role === 'owner' || principal?.source === 'personal-token' || principal?.source === 'local') return null;
  pruneWorkspaceLeases();
  const current = leases.get(workspaceId);
  if (!current) throw new Error(`Workspace ${workspaceId} requires a lease before ${capability} operations`);
  if (current.principalId !== principal?.id) {
    throw new Error(`Workspace ${workspaceId} is leased by ${current.principalName || current.principalId}`);
  }
  return { ...current };
}

export function clearWorkspaceLeases() {
  leases.clear();
  persist();
}

export const __test = { leases, persist, roleCanForce };
