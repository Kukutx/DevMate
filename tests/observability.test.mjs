import assert from 'node:assert/strict';
import test from 'node:test';
import {
  incrementCounter,
  metricsSnapshot,
  observeDuration,
  renderPrometheusMetrics,
  resetMetrics,
  setGauge
} from '../gateway/observability.mjs';

test.beforeEach(resetMetrics);

test('collects bounded counters, gauges, and duration aggregates', () => {
  incrementCounter('devmate_tool_calls_total', { tool: 'read_file', status: 'success' });
  incrementCounter('devmate_tool_calls_total', { tool: 'read_file', status: 'success' }, 2);
  setGauge('devmate_http_inflight', {}, 3);
  observeDuration('devmate_tool_duration_ms', { tool: 'read_file' }, 25);
  const snapshot = metricsSnapshot();
  assert.equal(snapshot.counters.find(item => item.name === 'devmate_tool_calls_total').value, 3);
  assert.equal(snapshot.gauges.find(item => item.name === 'devmate_http_inflight').value, 3);
  const prometheus = renderPrometheusMetrics();
  assert.match(prometheus, /devmate_tool_calls_total\{status="success",tool="read_file"\} 3/);
  assert.match(prometheus, /devmate_tool_duration_ms_sum\{tool="read_file"\} 25/);
});
