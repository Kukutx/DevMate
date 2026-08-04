'use strict';

class BridgeMetrics {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.startedAtMs = this.clock();
    this.active = 0;
    this.total = 0;
    this.errors = 0;
    this.lastRequestAt = null;
    this.actions = new Map();
  }

  begin(action) {
    const name = String(action || 'unknown') || 'unknown';
    this.active += 1;
    this.total += 1;
    return { action: name, startedAtMs: this.clock() };
  }

  finish(token, error = null) {
    if (!token) return;
    const endedAtMs = this.clock();
    const durationMs = Math.max(0, endedAtMs - token.startedAtMs);
    this.active = Math.max(0, this.active - 1);
    this.lastRequestAt = new Date(endedAtMs).toISOString();
    if (error) this.errors += 1;
    const stat = this.actions.get(token.action) || {
      action: token.action,
      requests: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      lastAt: null
    };
    stat.requests += 1;
    if (error) stat.errors += 1;
    stat.totalDurationMs += durationMs;
    stat.maxDurationMs = Math.max(stat.maxDurationMs, durationMs);
    stat.lastAt = this.lastRequestAt;
    this.actions.set(token.action, stat);
  }

  snapshot() {
    const nowMs = this.clock();
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeMs: Math.max(0, nowMs - this.startedAtMs),
      active: this.active,
      total: this.total,
      errors: this.errors,
      lastRequestAt: this.lastRequestAt,
      actions: [...this.actions.values()]
        .map(stat => ({
          action: stat.action,
          requests: stat.requests,
          errors: stat.errors,
          averageDurationMs: stat.requests ? Number((stat.totalDurationMs / stat.requests).toFixed(2)) : 0,
          maxDurationMs: stat.maxDurationMs,
          lastAt: stat.lastAt
        }))
        .sort((left, right) => left.action.localeCompare(right.action))
    };
  }
}

module.exports = { BridgeMetrics };
