import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const CONVERSATION_META_KEYS = Object.freeze([
  'openai/session',
  'openai/conversationId', 'openai/conversation_id', 'openai/conversation',
  'openai/threadId', 'openai/thread_id', 'openai/thread'
]);

function cleanMetaString(value, max = 4096) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function conversationScope(value) {
  const stable = cleanMetaString(value);
  if (!stable) return null;
  return `chatgpt-${crypto.createHash('sha256').update(stable, 'utf8').digest('hex').slice(0, 32)}`;
}
export function conversationScopeFromToolContext(context) {
  const meta = context?.mcpReq?._meta || context?._meta || {};
  for (const key of CONVERSATION_META_KEYS) {
    const scope = conversationScope(meta?.[key]);
    if (scope) return scope;
  }
  return null;
}
export function runWithRequestContext(context, fn) { return storage.run(Object.freeze({ ...(context || {}) }), fn); }
export function runWithConversationScope(value, fn) {
  const current = requestContext() || {};
  return storage.run(Object.freeze({ ...current, conversationScope: value || current.conversationScope || null }), fn);
}
export function runWithWorkSessionContext(workSessionId, fn) {
  const current = requestContext() || {};
  return storage.run(Object.freeze({ ...current, workSessionId: workSessionId || null }), fn);
}
export function runWithRequestSignal(signal, fn) {
  const current = requestContext() || {};
  return storage.run(Object.freeze({ ...current, signal: signal || current.signal || null }), fn);
}
export function requestContext() { return storage.getStore() || null; }
export function requestPrincipal() { return requestContext()?.principal || null; }
export function requestId() { return requestContext()?.requestId || null; }
export function requestConversationScope() { return requestContext()?.conversationScope || null; }
export function requestWorkSessionId() { return requestContext()?.workSessionId || null; }
export function requestSignal() { return requestContext()?.signal || null; }
export const __test = { CONVERSATION_META_KEYS, cleanMetaString, conversationScope };
