import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithRequestContext(context, fn) {
  return storage.run(Object.freeze({ ...(context || {}) }), fn);
}

export function runWithWorkSessionContext(workSessionId, fn) {
  const current = requestContext() || {};
  return storage.run(Object.freeze({ ...current, workSessionId: workSessionId || null }), fn);
}

export function runWithRequestSignal(signal, fn) {
  const current = requestContext() || {};
  return storage.run(Object.freeze({ ...current, signal: signal || current.signal || null }), fn);
}

export function requestContext() {
  return storage.getStore() || null;
}

export function requestPrincipal() {
  return requestContext()?.principal || null;
}

export function requestId() {
  return requestContext()?.requestId || null;
}

export function requestWorkSessionId() {
  return requestContext()?.workSessionId || null;
}

export function requestSignal() {
  return requestContext()?.signal || null;
}
