/**
 * Supervise only an owned, explicitly started native connection process.
 * An unavailable executable or missing credential at initial start is not
 * silently retried. Unexpected exits after a successful start get bounded,
 * observable retries. Disabling cancels all future automatic spawns.
 */
export function createConnectionRecovery({ restart, onError = () => {},
  baseDelayMs = 1000, maxDelayMs = 60000, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof restart !== 'function') throw new TypeError('A restart callback is required.');
  let enabled = false, timer = null, retryAt = null, failures = 0, startedAt = 0;
  function enable() {
    enabled = true;
    if (!startedAt) startedAt = now();
  }
  function disable() {
    enabled = false;
    if (timer !== null) cancel(timer);
    timer = null;
    retryAt = null;
    failures = 0;
    startedAt = 0;
  }
  function unexpectedExit() {
    if (!enabled || timer !== null) return;
    if (startedAt && now() - startedAt > 30000) failures = 0;
    const delay = Math.min(maxDelayMs,baseDelayMs * (2 ** Math.min(failures++,16)));
    retryAt = now() + delay;
    timer = schedule(async () => {
      timer = null; retryAt = null;
      if (!enabled) return;
      try {
        await restart();
        startedAt = now();
      } catch (error) {
        onError(error);
        unexpectedExit();
      }
    }, delay);
    timer?.unref?.();
  }
  const status = () => ({
    autoReconnect: enabled, retryScheduled: timer !== null,
    ...(retryAt !== null ? {retryAt:new Date(retryAt).toISOString()} : {})
  });
  return {enable,disable,unexpectedExit,status};
}
