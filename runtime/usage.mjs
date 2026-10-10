// What every operation was called for and how it went, since this runtime started: how often, by whom, how long,
// and with which errors. It answers two questions nothing else does: which tools a model keeps using wrongly, and
// what became slow. Nothing of a call's input is kept; a failure keeps its code and the start of its message.
const RECENT_FAILURES = 50;
// Durations are counted in fixed steps (upper bounds in milliseconds): enough to tell the usual case from the slow one
// without keeping any single measurement. An average hides the occasional slow call, and a maximum is one hiccup.
const STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
const percentile = (counts, total, share) => {
  let seen = 0;
  for (let index = 0; index < counts.length; index++) { seen += counts[index]; if (seen >= total * share) return STEPS[index] ?? null; }
  return null;
};

export function createUsage({ now = Date.now, clock = () => performance.now() } = {}) {
  const operations = new Map(), recent = [];
  let requests = 0;
  // Called when a call starts; what it returns is called when the call ends, with the error if it failed.
  function begin(name, context) {
    const request = ++requests, started = clock(), connected = context?.surface !== 'local';
    return error => {
      const ms = clock() - started;
      let entry = operations.get(name);
      if (!entry) operations.set(name, entry = { calls: 0, connected: 0, failed: 0, errors: {}, totalMs: 0, maxMs: 0, steps: new Array(STEPS.length + 1).fill(0) });
      entry.calls++; entry.totalMs += ms;
      const step = STEPS.findIndex(bound => ms <= bound);
      entry.steps[step < 0 ? STEPS.length : step]++;
      if (connected) entry.connected++;
      if (ms > entry.maxMs) entry.maxMs = ms;
      if (!error) return;
      const code = String(error.code || (error.name === 'ZodError' ? 'invalid_input' : 'internal_error')).slice(0, 80);
      entry.failed++; entry.errors[code] = (entry.errors[code] || 0) + 1;
      recent.push({ request, at: new Date(now()).toISOString(), operation: name, code, message: String(error.message || '').slice(0, 300),
        ms: Math.round(ms), caller: connected ? 'connected' : 'local' });
      if (recent.length > RECENT_FAILURES) recent.shift();
    };
  }
  // Most used first. connected: calls that came through MCP rather than from the owner at this computer.
  // p50Ms and p95Ms: half, and nineteen in twenty, of the calls took at most this long (null: longer than the last step).
  const snapshot = () => ({ requests,
    operations: [...operations].map(([name, entry]) => ({ name, calls: entry.calls, connected: entry.connected, failed: entry.failed,
      ...(entry.failed ? { errors: { ...entry.errors } } : {}), averageMs: Math.round(entry.totalMs / entry.calls), p50Ms: percentile(entry.steps, entry.calls, 0.5), p95Ms: percentile(entry.steps, entry.calls, 0.95), maxMs: Math.round(entry.maxMs) }))
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    recentFailures: [...recent].reverse() });
  return { begin, snapshot };
}
