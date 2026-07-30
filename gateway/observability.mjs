const counters = new Map();
const gauges = new Map();

function labelKey(labels = {}) {
  return Object.entries(labels)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('|');
}

function metricKey(name, labels) {
  return `${name}|${labelKey(labels)}`;
}

function sanitizeName(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_:]/g, '_');
}

function sanitizeLabel(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').slice(0, 300);
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
  const key = metricKey(sanitizeName(name), labels);
  counters.set(key, (counters.get(key) || 0) + Number(amount || 0));
}

export function setGauge(name, labels = {}, value = 0) {
  gauges.set(metricKey(sanitizeName(name), labels), Number(value || 0));
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
    gauges: publicEntries(gauges)
  };
}

function renderLabels(labels) {
  const entries = Object.entries(labels || {});
  if (!entries.length) return '';
  return `{${entries.map(([key, value]) => `${sanitizeName(key)}="${sanitizeLabel(value)}"`).join(',')}}`;
}

export function renderPrometheusMetrics() {
  const lines = [
    '# HELP devmate_info DevMate gateway build and runtime information.',
    '# TYPE devmate_info gauge',
    'devmate_info 1'
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
}

export const __test = { counters, gauges, labelKey, metricKey, parseMetricKey, renderLabels };
