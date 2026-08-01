export const MAX_METRIC_SERIES = 5000;
export const MAX_METRIC_LABELS = 20;
export const MAX_METRIC_LABEL_VALUE_CHARS = 200;

const counters = new Map();
const gauges = new Map();
const dropped = { counters: 0, gauges: 0 };

function sanitizeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_:]/g, '_').slice(0, 200) || 'devmate_metric';
}

function sanitizeLabelKey(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 100) || 'label';
}

function normalizeHighCardinalityValue(value) {
  return String(value ?? '')
    .replace(/^\/runner\/v1\/jobs\/[^/]+\/(renew|complete|fail|cancelled)$/i, '/runner/v1/jobs/:id/$1')
    .replace(/\bjob-[a-z0-9-]{12,}\b/gi, 'job-:id')
    .replace(/\b(?:req|runner)-[a-z0-9-]{12,}\b/gi, '$&'.split('-')[0] + '-:id');
}

function sanitizeLabelValue(value) {
  return normalizeHighCardinalityValue(value)
    .replace(/[\r\n\0]/g, ' ')
    .slice(0, MAX_METRIC_LABEL_VALUE_CHARS);
}

function normalizeLabels(labels = {}) {
  const entries = Object.entries(labels && typeof labels === 'object' ? labels : {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .slice(0, MAX_METRIC_LABELS)
    .map(([key, value]) => [sanitizeLabelKey(key), sanitizeLabelValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function labelKey(labels = {}) {
  return Object.entries(normalizeLabels(labels))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

function metricKey(name, labels) {
  return `${sanitizeName(name)}|${labelKey(labels)}`;
}

function overflowKey(name) {
  return metricKey(name, { overflow: 'true' });
}

function boundedKey(map, kind, name, labels) {
  const key = metricKey(name, labels);
  if (map.has(key) || map.size < MAX_METRIC_SERIES) return key;
  dropped[kind] += 1;
  return overflowKey(name);
}

function parseMetricKey(key) {
  const separator = key.indexOf('|');
  const name = separator < 0 ? key : key.slice(0, separator);
  const encoded = separator < 0 ? '' : key.slice(separator + 1);
  const labels = {};
  if (encoded) {
    for (const item of encoded.split('|')) {
      const index = item.indexOf('=');
      if (index > 0) labels[item.slice(0, index)] = item.slice(index + 1);
    }
  }
  return { name, labels };
}

function publicEntries(map) {
  return [...map.entries()].map(([key, value]) => ({ ...parseMetricKey(key), value }));
}

export function incrementCounter(name, labels = {}, amount = 1) {
  const key = boundedKey(counters, 'counters', name, labels);
  counters.set(key, (counters.get(key) || 0) + Number(amount || 0));
}

export function setGauge(name, labels = {}, value = 0) {
  const key = boundedKey(gauges, 'gauges', name, labels);
  gauges.set(key, Number(value || 0));
}

export function observeDuration(name, labels, durationMs) {
  const value = Math.max(0, Number(durationMs) || 0);
  incrementCounter(`${name}_count`, labels, 1);
  incrementCounter(`${name}_sum`, labels, value);
}

export function metricsSnapshot() {
  return {
    generatedAt: new Date().toISOString(),
    counters: publicEntries(counters),
    gauges: publicEntries(gauges),
    capacity: {
      maxSeriesPerKind: MAX_METRIC_SERIES,
      counterSeries: counters.size,
      gaugeSeries: gauges.size,
      droppedCounterSeries: dropped.counters,
      droppedGaugeSeries: dropped.gauges
    }
  };
}

function escapePrometheusLabel(value) {
  return sanitizeLabelValue(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function renderLabels(labels) {
  const entries = Object.entries(labels || {});
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${sanitizeLabelKey(key)}="${escapePrometheusLabel(value)}"`).join(',')}}`;
}

export function renderPrometheusMetrics() {
  const lines = [
    '# HELP devmate_info DevMate gateway build and runtime information.',
    '# TYPE devmate_info gauge',
    'devmate_info 1',
    '# HELP devmate_metric_series_dropped_total Metric series collapsed after the in-memory cardinality cap.',
    '# TYPE devmate_metric_series_dropped_total counter',
    `devmate_metric_series_dropped_total{kind="counter"} ${dropped.counters}`,
    `devmate_metric_series_dropped_total{kind="gauge"} ${dropped.gauges}`
  ];
  for (const item of publicEntries(counters).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${sanitizeName(item.name)}${renderLabels(item.labels)} ${Number(item.value) || 0}`);
  }
  for (const item of publicEntries(gauges).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${sanitizeName(item.name)}${renderLabels(item.labels)} ${Number(item.value) || 0}`);
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetrics() {
  counters.clear();
  gauges.clear();
  dropped.counters = 0;
  dropped.gauges = 0;
}

export const __test = {
  boundedKey,
  counters,
  dropped,
  gauges,
  labelKey,
  metricKey,
  normalizeHighCardinalityValue,
  normalizeLabels,
  parseMetricKey,
  renderLabels,
  sanitizeLabelKey,
  sanitizeLabelValue
};
