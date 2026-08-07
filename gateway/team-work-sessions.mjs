import crypto from 'node:crypto';
import { readDurableNamespace, writeDurableNamespace } from './durable-state.mjs';
import { acquireWorkspaceLease, releaseWorkspaceLease, workspaceLease } from './workspace-leases.mjs';

const NAMESPACE = 'team-work-sessions';
const restored = readDurableNamespace(NAMESPACE, []);
const sessions = new Map((Array.isArray(restored) ? restored : [])
  .filter(item => item?.id && item?.principalId && item?.workspaceId)
  .map(item => [item.id, item]));

function key(principalId, workspaceId) { return `${principalId}:${workspaceId}`; }
function nowIso() { return new Date().toISOString(); }
function persist() { writeDurableNamespace(NAMESPACE, [...sessions.values()]); }

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessions) {
    if (Date.parse(session.expiresAt) <= now) {
      sessions.delete(id);
      changed = true;
    }
  }
  if (changed) persist();
}

export function startWorkSession({ principal, workspaceId, title = '', purpose = '', ttlSeconds = 3600, force = false }) {
  prune();
  if (!principal?.id) throw new Error('Authenticated principal is required');
  const ttl = Math.min(86400, Math.max(300, Math.trunc(Number(ttlSeconds) || 3600)));
  const lease = acquireWorkspaceLease({ workspaceId, principal, ttlSeconds: ttl, purpose: purpose || title, force });
  const existing = [...sessions.values()].find(item => item.principalId === principal.id && item.workspaceId === workspaceId);
  if (existing) sessions.delete(existing.id);
  const session = {
    id: `work-${crypto.randomBytes(8).toString('hex')}`,
    principalId: principal.id,
    principalName: principal.name || principal.id,
    principalRole: principal.role,
    workspaceId,
    title: String(title || '').trim().slice(0, 500),
    purpose: String(purpose || '').trim().slice(0, 1000),
    startedAt: nowIso(),
    lastActivityAt: nowIso(),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    leaseId: lease.id,
    toolCalls: 0,
    failures: 0
  };
  sessions.set(session.id, session);
  persist();
  return { ...session, lease };
}

export function activeWorkSession(principalId, workspaceId) {
  prune();
  return [...sessions.values()].find(item => item.principalId === principalId && (!workspaceId || item.workspaceId === workspaceId)) || null;
}

export function touchWorkSession(principalId, workspaceId, { failed = false } = {}) {
  const session = activeWorkSession(principalId, workspaceId);
  if (!session) return null;
  session.lastActivityAt = nowIso();
  session.toolCalls += 1;
  if (failed) session.failures += 1;
  persist();
  return { ...session };
}

export function listWorkSessions({ principalId, workspaceId } = {}) {
  prune();
  return [...sessions.values()]
    .filter(item => (!principalId || item.principalId === principalId) && (!workspaceId || item.workspaceId === workspaceId))
    .map(item => ({ ...item, lease: workspaceLease(item.workspaceId) }))
    .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
}

export function finishWorkSession({ id, principal, force = false, releaseLease = true }) {
  prune();
  const session = sessions.get(id);
  if (!session) return { finished: false, id, reason: 'not found or expired' };
  if (principal?.workspaceIds?.length && !principal.workspaceIds.includes(session.workspaceId)) {
    throw new Error(`Principal ${principal.id} is not allowed to finish a session for workspace ${session.workspaceId}`);
  }
  const canForce = principal?.role === 'owner' || principal?.role === 'maintainer';
  if (session.principalId !== principal?.id && !(force && canForce)) throw new Error(`Work session ${id} belongs to ${session.principalName || session.principalId}`);

  let lease = null;
  if (releaseLease) {
    const currentLease = workspaceLease(session.workspaceId);
    if (!currentLease) {
      lease = { released: false, workspaceId: session.workspaceId, reason: 'not leased' };
    } else if (currentLease.id !== session.leaseId || currentLease.principalId !== session.principalId) {
      lease = { released: false, workspaceId: session.workspaceId, reason: 'lease changed since session started' };
    } else {
      lease = releaseWorkspaceLease({ workspaceId: session.workspaceId, principal, force: force && canForce });
    }
  }

  sessions.delete(id);
  persist();
  return { finished: true, session: { ...session, finishedAt: nowIso() }, lease };
}

export function clearWorkSessions() {
  sessions.clear();
  persist();
}

export const __test = { key, persist, prune, sessions };
