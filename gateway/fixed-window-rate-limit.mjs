const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;

function cleanLimit(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

export function pruneFixedWindowStore(store, {
  currentWindow,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (!(store instanceof Map)) throw new TypeError('Rate-limit store must be a Map');
  const cap = cleanLimit(maxEntries, DEFAULT_MAX_ENTRIES, 100, 100_000);
  const activeWindow = Number.isFinite(Number(currentWindow)) ? Number(currentWindow) : null;
  if (activeWindow != null) {
    for (const [key, value] of store) {
      if (!value || Number(value.window) < activeWindow - 1) store.delete(key);
    }
  }
  if (store.size <= cap) return 0;
  const remove = [...store.entries()]
    .sort((a, b) => Number(a[1]?.lastSeenAt || 0) - Number(b[1]?.lastSeenAt || 0))
    .slice(0, store.size - cap);
  for (const [key] of remove) store.delete(key);
  return remove.length;
}

export function consumeFixedWindow(store, key, limit, {
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (!(store instanceof Map)) throw new TypeError('Rate-limit store must be a Map');
  const boundedLimit = cleanLimit(limit, 1, 1, 1_000_000);
  const boundedWindowMs = cleanLimit(windowMs, DEFAULT_WINDOW_MS, 1_000, 24 * 60 * 60 * 1000);
  const window = Math.floor(Number(now) / boundedWindowMs);
  if (!store.has(key) && store.size >= maxEntries) {
    pruneFixedWindowStore(store, { currentWindow: window, maxEntries: Math.max(100, maxEntries - 1) });
  }
  const current = store.get(key);
  if (!current || current.window !== window) {
    store.set(key, { window, count: 1, lastSeenAt: Number(now) });
    return {
      allowed: true,
      remaining: Math.max(0, boundedLimit - 1),
      resetAt: (window + 1) * boundedWindowMs
    };
  }
  current.lastSeenAt = Number(now);
  if (current.count >= boundedLimit) {
    return { allowed: false, remaining: 0, resetAt: (window + 1) * boundedWindowMs };
  }
  current.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, boundedLimit - current.count),
    resetAt: (window + 1) * boundedWindowMs
  };
}

export const __test = { DEFAULT_MAX_ENTRIES, DEFAULT_WINDOW_MS, cleanLimit };
