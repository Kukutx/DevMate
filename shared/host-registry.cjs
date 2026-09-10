'use strict';

const DEFAULT_DEAD_HOST_GRACE_MS = 30000;
const DEFAULT_STALE_HOST_MS = 10 * 60 * 1000;

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

function hostEntries(config) {
  return Object.entries(object(config?.hostContexts))
    .filter(([, context]) => context && typeof context === 'object' && !Array.isArray(context))
    .sort(([, left], [, right]) => timestampMs(right) - timestampMs(left));
}

function selectionExists(config, hostId) {
  return !!hostId && !!object(config?.hostContexts)[hostId];
}

function repairSelection(config) {
  config.hostRuntime ||= {};
  const focusedHostId = String(config.hostRuntime.focusedHostId || '');
  if (selectionExists(config, focusedHostId)) {
    config.activeHostId = focusedHostId;
    return focusedHostId;
  }

  const activeHostId = String(config.activeHostId || '');
  if (selectionExists(config, activeHostId)) {
    config.hostRuntime.focusedHostId = activeHostId;
    return activeHostId;
  }

  const next = hostEntries(config)[0]?.[0] || '';
  if (next) {
    config.activeHostId = next;
    config.hostRuntime.focusedHostId = next;
  } else {
    delete config.activeHostId;
    delete config.hostRuntime.focusedHostId;
  }
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
    delete config.hostContexts[hostId];
    removed.push(hostId);
  }

  repairSelection(config);
  return { removed };
}

function publishHostContext(config, hostId, context = {}, options = {}) {
  const id = String(hostId || '').trim();
  if (!id) throw new Error('DevMate hostId is required');
  const stamp = context.updatedAt || context.capturedAt || new Date().toISOString();

  pruneStaleHostContexts(config, { ...options, keepHostId: id });
  config.hostContexts ||= {};
  config.hostRuntime ||= {};
  const next = {
    ...context,
    hostId: id,
    pid: Number.isInteger(Number(context.pid)) && Number(context.pid) > 0 ? Number(context.pid) : process.pid,
    updatedAt: stamp
  };
  config.hostContexts[id] = next;

  const focused = context.focused === true;
  const current = String(config.activeHostId || '');
  if (focused || !selectionExists(config, current)) {
    config.activeHostId = id;
    config.hostRuntime.focusedHostId = id;
  }
  if (focused) {
    config.hostRuntime.lastInteractiveHostId = id;
    config.hostRuntime.lastInteractiveAt = stamp;
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
  if (requested) return contexts[requested] || null;
  const focused = String(config?.hostRuntime?.focusedHostId || '');
  if (focused && contexts[focused]) return contexts[focused];
  const active = String(config?.activeHostId || '');
  if (active && contexts[active]) return contexts[active];
  return hostEntries(config)[0]?.[1] || null;
}

module.exports = {
  DEFAULT_DEAD_HOST_GRACE_MS,
  DEFAULT_STALE_HOST_MS,
  clearHostContext,
  hostEntries,
  processAlive,
  pruneStaleHostContexts,
  publishHostContext,
  repairSelection,
  selectHostContext,
  timestampMs
};
