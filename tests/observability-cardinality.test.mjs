import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_METRIC_SERIES,
  __test,
  incrementCounter,
  metricsSnapshot,
  renderPrometheusMetrics,
  resetMetrics,
  setGauge
} from '../gateway/observability.mjs';

test.beforeEach(() => resetMetrics());

test('normalizes per-job Runner routes before creating metric series', () => {
  incrementCounter('devmate_runner_control_requests_total', {
    route: '/runner/v1/jobs/job-abc123def456/complete',
    status: 200
  });
  incrementCounter('devmate_runner_control_requests_total', {
    route: '/runner/v1/jobs/job-xyz987uvw654/complete',
    status: 200
  });
  const snapshot = metricsSnapshot();
  assert.equal(snapshot.counters.length, 1);
  assert.equal(snapshot.counters[0].labels.route, '/runner/v1/jobs/:id/complete');
  assert.equal(snapshot.counters[0].value, 2);
});

test('bounds labels and collapses series after the hard cap', () => {
  for (let index = 0; index < MAX_METRIC_SERIES + 50; index += 1) {
    incrementCounter('devmate_test_total', { identity: `identity-${index}` });
  }
  for (let index = 0; index < MAX_METRIC_SERIES + 50; index += 1) {
    setGauge('devmate_test_gauge', { identity: `identity-${index}` }, index);
  }
  const snapshot = metricsSnapshot();
  assert.ok(snapshot.capacity.counterSeries <= MAX_METRIC_SERIES);
  assert.ok(snapshot.capacity.gaugeSeries <= MAX_METRIC_SERIES);
  assert.ok(snapshot.capacity.droppedCounterSeries > 0);
  assert.ok(snapshot.capacity.droppedGaugeSeries > 0);
  assert.ok(snapshot.counters.some(item => item.labels.overflow === 'true'));
  assert.ok(snapshot.gauges.some(item => item.labels.overflow === 'true'));
});

test('renders escaped bounded Prometheus labels without internal delimiter injection', () => {
  incrementCounter('unsafe metric', { 'bad-key': 'left|right\n"quoted"' });
  const snapshot = metricsSnapshot();
  assert.equal(snapshot.counters.length, 1);
  assert.equal(snapshot.counters[0].labels.bad_key.includes('|'), false);
  const output = renderPrometheusMetrics();
  assert.match(output, /unsafe_metric\{bad_key="left right \\"quoted\\""\} 1/);
  assert.match(output, /devmate_metric_series_dropped_total/);
  assert.equal(__test.sanitizeLabelValue('x'.repeat(500)).length, 200);
});
