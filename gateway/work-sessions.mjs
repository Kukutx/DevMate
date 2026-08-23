import crypto from 'node:crypto';
import { mutateDurableDocument, readDurableNamespace } from './durable-state.mjs';
import {
  acquireWorkspaceLeaseInDocument,
  releaseWorkspaceLeaseInDocument,
  syncWorkspaceLeasesFromDurableState,
  workspaceLease,
  workspaceLeaseInDocument
} from './workspace-leases.mjs';

const NAMESPACE = 'work-sessions';
const sessions = new Map();

function nowIso(now = Date.now()) { return new Date(now).toISOString(); }

function sessionStateError(message, detail = {}) {
  const error = new Error(`Work session durable state is invalid: ${message}`);
  error.code = 'work_session_state_invalid';
  Object.assign(error, detail);
  return error;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function normalizeSession(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw sessionStateError(`session ${index} must be an object`, { sessionIndex: index });
  }
  for (const field of ['id', 'principalId', 'workspaceId', 'leaseId']) {
    if (!nonEmpty(item[field])) throw sessionStateError(`session ${index} is missing ${field}`, { sessionIndex: index });
  }
  for (const field of ['startedAt', 'lastActivityAt', 'expiresAt']) {
    if (!validTimestamp(item[field])) throw sessionStateError(`session ${item.id} has invalid ${field}`, { sessionId: item.id });
  }
  for (const field of ['toolCalls', 'failures']) {
    if (!Number.isSafeInteger(item[field]) || item[field] < 0) {
      throw sessionStateError(`session ${item.id} has invalid ${field}`, { sessionId: item.id });
    }
  }
  return { ...item };
}

function sessionMap(values) {
  if (values === undefined) return new Map();
  if (!Array.isArray(values)) throw sessionStateError('namespace must be an array');
  const output = new Map();
  values.forEach((item, index) => {
    const session = normalizeSession(item, index);
    if (output.has(session.id)) throw sessionStateError(`duplicate session id ${session.id}`, { sessionId: session.id });
    output.set(session.id, session);
  });
  return output;
}
function documentSessionMap(document) {
  return sessionMap(document?.namespaces?.[NAMESPACE]);
}
function writeDocumentSessions(document, values) {
  document.namespaces ||= {};
  document.namespaces[NAMESPACE] = [...values];
}
function pruneSessionMap(values, now = Date.now()) {
  let changed = false;
  for (const [id, session] of values) {
    if (Date.parse(session.expiresAt) <= now) {
      values.delete(id);
      changed = true;
    }
  }
  return changed;
}

export function syncWorkSessionsFromDurableState() {
  const next = sessionMap(readDurableNamespace(NAMESPACE, []));
  sessions.clear();
  for (const [id, session] of next) sessions.set(id, session);
  return sessions;
}

syncWorkSessionsFromDurableState();

function syncCaches() {
  syncWorkSessionsFromDurableState();
  syncWorkspaceLeasesFromDurableState();
}

function prune(now = Date.now()) {
  const expired = [...sessions.values()].some(session => Date.parse(session.expiresAt) <= now);
  if (!expired) return false;
  mutateDurableDocument(document => {
    const values = documentSessionMap(document);
    pruneSessionMap(values, now);
    writeDocumentSessions(document, values.values());
    return document;
  });
  syncWorkSessionsFromDurableState();
  return true;
}

export function startWorkSession({ principal, workspaceId, title = '', purpose = '', ttlSeconds = 3600, force = false }) {
  if (!principal?.id) throw new Error('Authenticated principal is required');
  const ttl = Math.min(86400, Math.max(300, Math.trunc(Number(ttlSeconds) || 3600)));
  const now = Date.now();
  let result = null;
  mutateDurableDocument(document => {
    const values = documentSessionMap(document);
    pruneSessionMap(values, now);
    const lease = acquireWorkspaceLeaseInDocument(document, {
      workspaceId,
      principal,
      ttlSeconds: ttl,
      purpose: purpose || title,
      force,
      now
    });
    const existing = [...values.values()].find(item => item.principalId === principal.id && item.workspaceId === workspaceId);
    if (existing) values.delete(existing.id);
    const timestamp = nowIso(now);
    const session = {
      id: `work-${crypto.randomBytes(8).toString('hex')}`,
      principalId: principal.id,
      principalName: principal.name || principal.id,
      principalRole: principal.role,
      workspaceId,
      title: String(title || '').trim().slice(0, 500),
      purpose: String(purpose || '').trim().slice(0, 1000),
      startedAt: timestamp,
      lastActivityAt: timestamp,
      expiresAt: new Date(now + ttl * 1000).toISOString(),
      leaseId: lease.id,
      toolCalls: 0,
      failures: 0
    };
    values.set(session.id, session);
    writeDocumentSessions(document, values.values());
    result = { session: { ...session }, lease: { ...lease } };
    return document;
  });
  syncCaches();
  return { ...result.session, lease: result.lease };
}

export function activeWorkSession(principalId, workspaceId) {
  prune();
  const session = [...sessions.values()].find(item => item.principalId === principalId && (!workspaceId || item.workspaceId === workspaceId));
  return session ? { ...session } : null;
}

export function workSession(id) {
  prune();
  const session = sessions.get(String(id || ''));
  return session ? { ...session, lease: workspaceLease(session.workspaceId) } : null;
}

export function touchWorkSession(principalId, workspaceId, { failed = false } = {}) {
  const now = Date.now();
  prune(now);
  const existing = [...sessions.values()].find(item => item.principalId === principalId && item.workspaceId === workspaceId);
  if (!existing) return null;
  let touched = null;
  mutateDurableDocument(document => {
    const values = documentSessionMap(document);
    pruneSessionMap(values, now);
    const session = [...values.values()].find(item => item.principalId === principalId && item.workspaceId === workspaceId);
    if (!session) {
      writeDocumentSessions(document, values.values());
      return document;
    }
    session.lastActivityAt = nowIso(now);
    session.toolCalls += 1;
    if (failed) session.failures += 1;
    touched = { ...session };
    writeDocumentSessions(document, values.values());
    return document;
  });
  syncWorkSessionsFromDurableState();
  return touched;
}

export function listWorkSessions({ principalId, workspaceId } = {}) {
  prune();
  return [...sessions.values()]
    .filter(item => (!principalId || item.principalId === principalId) && (!workspaceId || item.workspaceId === workspaceId))
    .map(item => ({ ...item, lease: workspaceLease(item.workspaceId) }))
    .sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
}

export function finishWorkSession({ id, principal, force = false, releaseLease = true }) {
  const now = Date.now();
  let result = null;
  mutateDurableDocument(document => {
    const values = documentSessionMap(document);
    pruneSessionMap(values, now);
    const session = values.get(String(id || ''));
    if (!session) {
      writeDocumentSessions(document, values.values());
      result = { finished: false, id, reason: 'not found or expired' };
      return document;
    }
    if (principal?.workspaceIds?.length && !principal.workspaceIds.includes(session.workspaceId)) {
      throw new Error(`Principal ${principal.id} is not allowed to finish a session for workspace ${session.workspaceId}`);
    }
    const canForce = principal?.role === 'owner' || principal?.role === 'maintainer';
    if (session.principalId !== principal?.id && !(force && canForce)) {
      throw new Error(`Work session ${id} belongs to ${session.principalName || session.principalId}`);
    }

    let lease = null;
    if (releaseLease) {
      const currentLease = workspaceLeaseInDocument(document, session.workspaceId, now);
      if (!currentLease) {
        lease = { released: false, workspaceId: session.workspaceId, reason: 'not leased' };
      } else if (currentLease.id !== session.leaseId || currentLease.principalId !== session.principalId) {
        lease = { released: false, workspaceId: session.workspaceId, reason: 'lease changed since session started' };
      } else {
        lease = releaseWorkspaceLeaseInDocument(document, {
          workspaceId: session.workspaceId,
          principal,
          force: force && canForce,
          now
        });
      }
    }

    values.delete(session.id);
    writeDocumentSessions(document, values.values());
    result = { finished: true, session: { ...session, finishedAt: nowIso(now) }, lease };
    return document;
  });
  syncCaches();
  return result;
}

export function clearWorkSessions() {
  mutateDurableDocument(document => {
    document.namespaces ||= {};
    document.namespaces[NAMESPACE] = [];
    return document;
  });
  syncWorkSessionsFromDurableState();
}

export const __test = {
  documentSessionMap,
  normalizeSession,
  pruneSessionMap,
  sessionMap,
  sessionStateError,
  sessions,
  syncWorkSessionsFromDurableState,
  writeDocumentSessions
};