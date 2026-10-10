import { runNativeQa } from './godot-native-qa.mjs';

const METRICS = Object.freeze({
  fps: { direction: 'min' },
  process_ms: { direction: 'max' },
  physics_ms: { direction: 'max' },
  memory_static_bytes: { direction: 'max' },
  object_count: { direction: 'max' },
  resource_count: { direction: 'max' },
  node_count: { direction: 'max' },
  orphan_node_count: { direction: 'max' },
  draw_calls: { direction: 'max' },
  video_memory_bytes: { direction: 'max' },
  physics_2d_active: { direction: 'max' },
  physics_2d_pairs: { direction: 'max' },
  physics_3d_active: { direction: 'max' },
  physics_3d_pairs: { direction: 'max' }
});

function finiteValues(samples, key, warmupMs = 0) {
  return samples
    .filter(sample => Number(sample?.elapsed_ms) >= warmupMs)
    .map(sample => Number(sample?.[key]))
    .filter(Number.isFinite);
}

export function percentile(values = [], fraction = 0.95) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function summarizeMetric(values) {
  if (!values.length) return { samples: 0, min: null, max: null, avg: null, p01: null, p05: null, p50: null, p95: null, p99: null };
  return {
    samples: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p01: percentile(values, 0.01),
    p05: percentile(values, 0.05),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99)
  };
}

export function summarizePerformance(report, { warmupMs = 1000 } = {}) {
  const raw = Array.isArray(report?.performance?.samples) ? report.performance.samples : [];
  const boundedWarmup = Math.min(300000, Math.max(0, Math.trunc(Number(warmupMs) || 0)));
  const metrics = {};
  for (const key of Object.keys(METRICS)) metrics[key] = summarizeMetric(finiteValues(raw, key, boundedWarmup));
  return {
    enabled: report?.performance?.enabled === true,
    rawSamples: raw.length,
    evaluatedSamples: raw.filter(sample => Number(sample?.elapsed_ms) >= boundedWarmup).length,
    warmupMs: boundedWarmup,
    intervalMs: Number(report?.performance?.sample_interval_ms || 0),
    metrics
  };
}

const BUDGET_FIELDS = Object.freeze({
  minSamples: { metric: null, statistic: null, direction: 'min' },
  minFpsP05: { metric: 'fps', statistic: 'p05', direction: 'min' },
  minFpsP50: { metric: 'fps', statistic: 'p50', direction: 'min' },
  maxProcessMsP95: { metric: 'process_ms', statistic: 'p95', direction: 'max' },
  maxPhysicsMsP95: { metric: 'physics_ms', statistic: 'p95', direction: 'max' },
  maxMemoryBytes: { metric: 'memory_static_bytes', statistic: 'max', direction: 'max' },
  maxNodeCount: { metric: 'node_count', statistic: 'max', direction: 'max' },
  maxOrphanNodeCount: { metric: 'orphan_node_count', statistic: 'max', direction: 'max' },
  maxDrawCallsP95: { metric: 'draw_calls', statistic: 'p95', direction: 'max' },
  maxPhysics2dPairs: { metric: 'physics_2d_pairs', statistic: 'max', direction: 'max' },
  maxPhysics3dPairs: { metric: 'physics_3d_pairs', statistic: 'max', direction: 'max' }
});

export function evaluatePerformanceBudgets(summary, budgets = {}) {
  for (const field of Object.keys(budgets || {})) {
    if (!Object.hasOwn(BUDGET_FIELDS, field)) throw new Error(`Unknown Godot performance budget: ${field}`);
  }
  const results = [];
  for (const [field, definition] of Object.entries(BUDGET_FIELDS)) {
    if (budgets[field] == null) continue;
    const expected = Number(budgets[field]);
    if (!Number.isFinite(expected)) throw new Error(`Godot performance budget ${field} must be a finite number`);
    const actual = field === 'minSamples'
      ? summary.evaluatedSamples
      : summary.metrics?.[definition.metric]?.[definition.statistic];
    const available = Number.isFinite(actual);
    const passed = available && (definition.direction === 'min' ? actual >= expected : actual <= expected);
    results.push({ field, metric: definition.metric, statistic: definition.statistic, direction: definition.direction, expected, actual: available ? actual : null, available, passed });
  }
  return {
    configured: results.length,
    passed: results.filter(item => item.passed).length,
    failed: results.filter(item => !item.passed).length,
    ok: results.every(item => item.passed),
    results
  };
}

export async function runPerformanceTest(context, {
  warmupMs = 1000,
  sampleIntervalMs = 250,
  maxSamples = 600,
  budgets = {},
  ...nativeArgs
} = {}) {
  const native = await runNativeQa(context, {
    reportPath: 'artifacts/godot-performance/latest.json',
    runForMs: 5000,
    ...nativeArgs,
    performance: { enabled: true, sampleIntervalMs, maxSamples }
  });
  const summary = summarizePerformance(native.report, { warmupMs });
  const budget = evaluatePerformanceBudgets(summary, budgets);
  const samplesAvailable = summary.evaluatedSamples > 0;
  return {
    ...native,
    ok: native.ok && samplesAvailable && budget.ok,
    performance: { summary, budget },
    checks: { ...native.checks, performanceSamples: samplesAvailable, performanceBudgets: budget.ok }
  };
}

export async function runMovieCapture(context, {
  moviePath = 'artifacts/godot-capture/latest.avi',
  fps = 30,
  frames = 180,
  disableVsync = true,
  performance = false,
  performanceBudgets = {},
  ...nativeArgs
} = {}) {
  const native = await runNativeQa(context, {
    reportPath: 'artifacts/godot-capture/latest.json',
    runForMs: Math.max(3000, Math.ceil((Number(frames) || 180) / (Number(fps) || 30) * 1000) + 1000),
    ...nativeArgs,
    headless: false,
    capture: { moviePath, fps, frames, disableVsync },
    performance: performance ? { enabled: true, sampleIntervalMs: 250, maxSamples: 600 } : undefined
  });
  if (!performance) return native;
  const summary = summarizePerformance(native.report, { warmupMs: 0 });
  const budget = evaluatePerformanceBudgets(summary, performanceBudgets);
  return { ...native, ok: native.ok && summary.evaluatedSamples > 0 && budget.ok, performance: { summary, budget } };
}

export function compactPerformanceResult(result) {
  return {
    ok: result.ok,
    workspace: result.workspace,
    projectSubpath: result.projectSubpath,
    scene: result.scene,
    headless: result.headless,
    reportPath: result.reportPath,
    artifactPaths: result.artifactPaths,
    capture: result.capture || null,
    performance: result.performance || null,
    assertionResults: result.assertionResults,
    missingCheckpoints: result.missingCheckpoints,
    diagnostics: result.diagnostics,
    checks: result.checks,
    process: {
      exitCode: result.result?.exitCode ?? null,
      timedOut: result.result?.timedOut === true,
      stdoutTruncated: result.result?.stdoutTruncated === true,
      stderrTruncated: result.result?.stderrTruncated === true
    }
  };
}

export const __test = { BUDGET_FIELDS, METRICS, finiteValues, summarizeMetric };
