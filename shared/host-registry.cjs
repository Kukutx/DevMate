'use strict';

const DEFAULT_DEAD_HOST_GRACE_MS = 30000;
const DEFAULT_STALE_HOST_MS = 10 * 60 * 1000;
const MAX_HOST_CONTEXT_CHARS = 200000;
const HOST_CONTEXT_PUBLISHER = Symbol.for('devmate.hostContextPublisher');
const HOST_CONTEXT_PRUNED = Symbol.for('devmate.hostContextPruned');
const HOST_CONTEXT_CONTROL_FIELDS = Object.freeze([
  'hostId',
  'pid',
  'kind',
  'focused',
  'workspaceRoot',
  'capturedAt',
  'updatedAt'
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function timestampMs(context) {
  const value = Date.parse(context?.updatedAt || context?.capturedAt || '');
  return Number.isFinite(value) ? value : 0;
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function boundedHostContext(value, maxChars = MAX_HOST_CONTEXT_CHARS) {
  const context = object(value);
  const limit = Math.max(1024, Math.trunc(Number(maxChars) || MAX_HOST_CONTEXT_CHARS));
  const serialized = JSON.stringify(context);
  if (serialized.length <= limit) return context;

  const control = {};
  for (const key of HOST_CONTEXT_CONTROL_FIELDS) {
    if (Object.hasOwn(context, key)) control[key] = context[key];
  }
  let base = {
    ...control,
    truncated: true,
    originalChars: serialized.length,
    preview: ''
  };
  if (JSON.stringify(base).length > limit) {
    base = {
      hostId: String(control.hostId || '').slice(0, 256),
      pid: Number.isInteger(Number(control.pid)) && Number(control.pid) > 0 ? Number(control.pid) : process.pid,
      kind: String(control.kind || '').slice(0, 64),
      focused: control.focused === true,
      workspaceRoot: String(control.workspaceRoot || '').slice(0, Math.max(0, limit - 1024)),
      capturedAt: String(control.capturedAt || '').slice(0, 64),
      updatedAt: String(control.updatedAt || '').slice(0, 64),
      truncated: true,
      originalChars: serialized.length,
      preview: ''
    };
  }

  let low = 0;
  let high = serialized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...base, preview: serialized.slice(0, middle) };
    if (JSON.stringify(candidate).length <= limit) low = middle;
    else high = middle - 1;
  }
  return { ...base, preview: serialized.slice(0, low) };
}

function hostEntries(config) {
  return Object.entries(object(config?.hostContexts))
    .filter(([, context]) => context && typeof context === 'object' && !Array.isArray(context))
    .sort(([, left], [, right]) => timestampMs(right) - timestampMs(left));
}

function selectionExists(config, hostId) {
  return !!hostId && !!object(config?.hostContexts)[hostId];
}

function markPublisher(config, hostId) {
  Object.defineProperty(config, HOST_CONTEXT_PUBLISHER, {
    value: String(hostId || ''),
    enumerable: false,
    configurable: true,
    writable: true
  });
}

function publisherHostId(config) {
  return String(config?.[HOST_CONTEXT_PUBLISHER] || '');
}

function markPrunedContexts(config, contexts) {
  Object.defineProperty(config, HOST_CONTEXT_PRUNED, {
    value: { ...object(contexts) },
    enumerable: false,
    configurable: true,
    writable: true
  });
}

function prunedHostContexts(config) {
  return object(config?.[HOST_CONTEXT_PRUNED]);
}

function repairSelection(config) {
  config.hostRuntime ||= {};
  const focusedHostId = String(config.hostRuntime.focusedHostId || '');
  if (selectionExists(config, focusedHostId)) {
    config.activeHostId = focusedHostId;
    return focusedHostId;
  }
  if (focusedHostId) delete config.hostRuntime.focusedHostId;

  const activeHostId = String(config.activeHostId || '');
  if (selectionExists(config, activeHostId)) return activeHostId;

  const next = hostEntries(config)[0]?.[0] || '';
  if (next) config.activeHostId = next;
  else delete config.activeHostId;
  return next;
}

function pruneStaleHostContexts(config, {
  nowMs = Date.now(),
  processAliveImpl = processAlive,
  deadHostGraceMs = DEFAULT_DEAD_HOST_GRACE_MS,
  staleHostMs = DEFAULT_STALE_HOST_MS,
  keepHostId = ''
} = {}) {
  config.hostContexts ||= {};
  const removed = [];
  const removedContexts = {};
  const deadGrace = Math.max(0, Number(deadHostGraceMs) || DEFAULT_DEAD_HOST_GRACE_MS);
  const staleLimit = Math.max(deadGrace, Number(staleHostMs) || DEFAULT_STALE_HOST_MS);

  for (const [hostId, context] of Object.entries(config.hostContexts)) {
    if (hostId === keepHostId || !context || typeof context !== 'object' || Array.isArray(context)) continue;
    const updatedAt = timestampMs(context);
    const age = updatedAt > 0 ? Math.max(0, nowMs - updatedAt) : staleLimit;
    const pid = Number(context.pid);
    const hasPid = Number.isInteger(pid) && pid > 0;
    const stale = hasPid
      ? age >= deadGrace && !processAliveImpl(pid)
      : age >= staleLimit;
    if (!stale) continue;
    removedContexts[hostId] = context;
    delete config.hostContexts[hostId];
    removed.push(hostId);
  }

  if (removed.length) markPrunedContexts(config, removedContexts);
  repairSelection(config);
  return { removed, removedContexts };
}

function publishHostContext(config, hostId, context = {}, options = {}) {
  const id = String(hostId || '').trim();
  if (!id) throw new Error('DevMate hostId is required');
  const stamp = context.updatedAt || context.capturedAt || new Date().toISOString();

  pruneStaleHostContexts(config, { ...options, keepHostId: id });
  config.hostContexts ||= {};
  config.hostRuntime ||= {};
  const next = boundedHostContext({
    ...context,
    hostId: id,
    pid: Number.isInteger(Number(context.pid)) && Number(context.pid) > 0 ? Number(context.pid) : process.pid,
    updatedAt: stamp
  });
  config.hostContexts[id] = next;
  markPublisher(config, id);

  const focused = next.focused === true;
  const current = String(config.activeHostId || '');
  if (focused) {
    config.activeHostId = id;
    config.hostRuntime.focusedHostId = id;
    config.hostRuntime.lastInteractiveHostId = id;
    config.hostRuntime.lastInteractiveAt = stamp;
  } else {
    if (config.hostRuntime.focusedHostId === id) delete config.hostRuntime.focusedHostId;
    if (!selectionExists(config, current)) config.activeHostId = id;
  }
  repairSelection(config);
  return next;
}

function clearHostContext(config, hostId, options = {}) {
  const id = String(hostId || '').trim();
  config.hostContexts ||= {};
  if (id && Object.hasOwn(config.hostContexts, id)) delete config.hostContexts[id];
  if (config.hostRuntime?.focusedHostId === id) delete config.hostRuntime.focusedHostId;
  if (config.hostRuntime?.lastInteractiveHostId === id) delete config.hostRuntime.lastInteractiveHostId;
  pruneStaleHostContexts(config, options);
  repairSelection(config);
  return config;
}

function selectHostContext(config, hostId = '') {
  const contexts = object(config?.hostContexts);
  const requested = String(hostId || '').trim();
  if (requested) {
    if (contexts[requested]) return contexts[requested];
    return hostEntries(config).find(([id, context]) => id === requested || context.hostId === requested)?.[1] || null;
  }
  const focused = String(config?.hostRuntime?.focusedHostId || '');
  if (focused && contexts[focused]) return contexts[focused];
  const active = String(config?.activeHostId || '');
  if (active && contexts[active]) return contexts[active];
  return hostEntries(config)[0]?.[1] || null;
}

module.exports = {
  DEFAULT_DEAD_HOST_GRACE_MS,
  DEFAULT_STALE_HOST_MS,
  HOST_CONTEXT_PRUNED,
  HOST_CONTEXT_PUBLISHER,
  MAX_HOST_CONTEXT_CHARS,
  boundedHostContext,
  clearHostContext,
  hostEntries,
  markPrunedContexts,
  markPublisher,
  processAlive,
  pruneStaleHostContexts,
  prunedHostContexts,
  publishHostContext,
  publisherHostId,
  repairSelection,
  selectHostContext,
  timestampMs
};
