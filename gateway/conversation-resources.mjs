import { mutateDurableNamespace, readDurableNamespace } from './durable-state.mjs';
import { requestConversationScope } from './request-context.mjs';

const NAMESPACE = 'conversation-resources';
const MAX_RECORDS = 5000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function cleanKind(value) {
  const kind = String(value || '').trim();
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) throw new Error(`Invalid conversation resource kind: ${kind || '(empty)'}`);
  return kind;
}

function cleanId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 300) throw new Error('Conversation resource id is required');
  return id;
}

function cleanScope(value) {
  const scope = String(value || '').trim();
  return /^chatgpt-[a-f0-9]{32}$/.test(scope) ? scope : '';
}

function emptyStore() {
  return { version: 1, records: [] };
}

function readStore() {
  const raw = readDurableNamespace(NAMESPACE, emptyStore());
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.records)) return emptyStore();
  return { version: 1, records: raw.records.filter(item => item && typeof item === 'object' && !Array.isArray(item)) };
}

function prune(store, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  store.records = store.records
    .filter(item => Number.isFinite(Date.parse(item.updatedAt || item.createdAt || '')) && Date.parse(item.updatedAt || item.createdAt) >= cutoff)
    .slice(-MAX_RECORDS);
  return store;
}

export function bindConversationResource(kind, id, {
  scope = requestConversationScope(),
  workspaceId = null,
  now = Date.now()
} = {}) {
  const resourceKind = cleanKind(kind);
  const resourceId = cleanId(id);
  const conversationScope = cleanScope(scope);
  if (!conversationScope) {
    const error = new Error(`Cannot bind ${resourceKind} ${resourceId} without ChatGPT conversation metadata`);
    error.code = 'conversation_scope_unavailable';
    throw error;
  }
  const timestamp = new Date(now).toISOString();
  let bound = null;
  mutateDurableNamespace(NAMESPACE, emptyStore(), raw => {
    const store = prune(raw && raw.version === 1 && Array.isArray(raw.records) ? raw : emptyStore(), now);
    const existing = store.records.find(item => item.kind === resourceKind && item.id === resourceId);
    if (existing && cleanScope(existing.scope) && cleanScope(existing.scope) !== conversationScope) {
      const error = new Error(`${resourceKind} ${resourceId} is already bound to another ChatGPT conversation`);
      error.code = 'conversation_resource_conflict';
      throw error;
    }
    const record = {
      kind: resourceKind,
      id: resourceId,
      scope: conversationScope,
      workspaceId: workspaceId ? String(workspaceId) : existing?.workspaceId || null,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
    store.records = store.records.filter(item => !(item.kind === resourceKind && item.id === resourceId));
    store.records.push(record);
    bound = { ...record };
    return store;
  });
  return bound;
}

export function conversationResource(kind, id) {
  const resourceKind = cleanKind(kind);
  const resourceId = cleanId(id);
  const store = prune(readStore());
  const item = store.records.find(record => record.kind === resourceKind && record.id === resourceId);
  return item ? { ...item } : null;
}

export function conversationResourceScope(kind, id) {
  return cleanScope(conversationResource(kind, id)?.scope) || null;
}

export function assertConversationResource(kind, id, scope = requestConversationScope(), { allowLegacyUnscoped = false } = {}) {
  const current = cleanScope(scope);
  if (!current) return conversationResource(kind, id);
  const record = conversationResource(kind, id);
  if (record && cleanScope(record.scope) === current) return record;
  if (!record && allowLegacyUnscoped) return null;
  const error = new Error(record
    ? `${cleanKind(kind)} ${cleanId(id)} belongs to another ChatGPT conversation`
    : `${cleanKind(kind)} ${cleanId(id)} is not bound to this ChatGPT conversation and will not be adopted automatically`);
  error.code = 'conversation_resource_conflict';
  error.resourceKind = cleanKind(kind);
  error.resourceId = cleanId(id);
  throw error;
}

export function filterConversationResources(kind, items, {
  scope = requestConversationScope(),
  idField = 'id'
} = {}) {
  if (!Array.isArray(items)) return [];
  const current = cleanScope(scope);
  if (!current) return items;
  const resourceKind = cleanKind(kind);
  const records = new Map(
    prune(readStore()).records
      .filter(record => record.kind === resourceKind)
      .map(record => [record.id, record])
  );
  return items.filter(item => cleanScope(records.get(String(item?.[idField] || ''))?.scope) === current);
}

export function clearConversationResource(kind, id) {
  const resourceKind = cleanKind(kind);
  const resourceId = cleanId(id);
  let removed = false;
  mutateDurableNamespace(NAMESPACE, emptyStore(), raw => {
    const store = prune(raw && raw.version === 1 && Array.isArray(raw.records) ? raw : emptyStore());
    const before = store.records.length;
    store.records = store.records.filter(item => !(item.kind === resourceKind && item.id === resourceId));
    removed = store.records.length !== before;
    return store;
  });
  return removed;
}

export const __test = {
  MAX_RECORDS,
  NAMESPACE,
  RETENTION_MS,
  cleanId,
  cleanKind,
  cleanScope,
  emptyStore,
  prune,
  readStore
};
