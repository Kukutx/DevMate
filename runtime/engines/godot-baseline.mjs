import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { safeGodotBaselinePath, safeGodotRelativePath } from './godot-path-policy.mjs';
import { summarizePerformance } from './godot-performance.mjs';
import { resolveProject } from './godot-project.mjs';

const BASELINE_SCHEMA_VERSION = 1;
const METRIC_POINTS = Object.freeze([
  { key: 'fps_p05', metric: 'fps', statistic: 'p05', direction: 'min' },
  { key: 'fps_p50', metric: 'fps', statistic: 'p50', direction: 'min' },
  { key: 'process_ms_p95', metric: 'process_ms', statistic: 'p95', direction: 'max' },
  { key: 'physics_ms_p95', metric: 'physics_ms', statistic: 'p95', direction: 'max' },
  { key: 'memory_static_bytes_max', metric: 'memory_static_bytes', statistic: 'max', direction: 'max' },
  { key: 'node_count_max', metric: 'node_count', statistic: 'max', direction: 'max' },
  { key: 'orphan_node_count_max', metric: 'orphan_node_count', statistic: 'max', direction: 'max' },
  { key: 'draw_calls_p95', metric: 'draw_calls', statistic: 'p95', direction: 'max' },
  { key: 'physics_2d_pairs_max', metric: 'physics_2d_pairs', statistic: 'max', direction: 'max' },
  { key: 'physics_3d_pairs_max', metric: 'physics_3d_pairs', statistic: 'max', direction: 'max' }
]);

function safeId(value = 'default') {
  const id = String(value || 'default').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id || id.length > 100) throw new Error('Godot performance baseline id must contain 1-100 safe characters');
  return id;
}

function safeRelative(value, fallback) {
  return safeGodotRelativePath(value, fallback, 'Godot performance report path');
}

async function readJson(file, maxBytes = 8 * 1024 * 1024) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`JSON file not found: ${file}`);
  if (stat.size > maxBytes) throw new Error(`JSON file exceeds ${maxBytes} bytes: ${file}`);
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid JSON file ${file}: ${error.message}`); }
}

function metricSnapshot(summary) {
  const metrics = {};
  for (const point of METRIC_POINTS) {
    const value = summary.metrics?.[point.metric]?.[point.statistic];
    metrics[point.key] = Number.isFinite(Number(value)) ? Number(value) : null;
  }
  return metrics;
}

export function createPerformanceBaseline(summary, { id = 'default', scene = null, engineVersion = null, sourceReport = null } = {}) {
  if (!summary?.enabled || !Number.isFinite(Number(summary.evaluatedSamples)) || summary.evaluatedSamples < 1) {
    throw new Error('Performance baseline requires at least one evaluated performance sample');
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    id: safeId(id),
    createdAt: new Date().toISOString(),
    scene: scene || null,
    engineVersion: engineVersion || null,
    sourceReport: sourceReport || null,
    warmupMs: summary.warmupMs,
    evaluatedSamples: summary.evaluatedSamples,
    metrics: metricSnapshot(summary)
  };
}

function percentageChange(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return current === 0 ? 0 : null;
  return (current - baseline) / Math.abs(baseline) * 100;
}

export function comparePerformanceBaseline(summary, baseline, { maxRegressionPercent = 10, minSamplesRatio = 0.75, metricThresholds = {} } = {}) {
  if (baseline?.schemaVersion !== BASELINE_SCHEMA_VERSION || !baseline.metrics) throw new Error('Unsupported or invalid Godot performance baseline');
  const current = metricSnapshot(summary);
  const comparisons = [];
  for (const point of METRIC_POINTS) {
    const baselineValue = Number(baseline.metrics[point.key]);
    const currentValue = Number(current[point.key]);
    const available = Number.isFinite(baselineValue) && Number.isFinite(currentValue);
    const changePercent = available ? percentageChange(currentValue, baselineValue) : null;
    const allowed = Number.isFinite(Number(metricThresholds[point.key]))
      ? Math.max(0, Number(metricThresholds[point.key]))
      : Math.max(0, Number(maxRegressionPercent) || 0);
    const regressionPercent = !available || changePercent == null
      ? null
      : point.direction === 'min' ? -changePercent : changePercent;
    const passed = available && regressionPercent != null && regressionPercent <= allowed;
    comparisons.push({
      key: point.key,
      metric: point.metric,
      statistic: point.statistic,
      direction: point.direction,
      baseline: Number.isFinite(baselineValue) ? baselineValue : null,
      current: Number.isFinite(currentValue) ? currentValue : null,
      changePercent,
      regressionPercent,
      allowedRegressionPercent: allowed,
      available,
      passed
    });
  }
  const requiredSamples = Math.max(1, Math.ceil(Number(baseline.evaluatedSamples || 1) * Math.min(1, Math.max(0.1, Number(minSamplesRatio) || 0.75))));
  const sampleCheck = { baseline: baseline.evaluatedSamples, current: summary.evaluatedSamples, required: requiredSamples, passed: summary.evaluatedSamples >= requiredSamples };
  return {
    ok: sampleCheck.passed && comparisons.every(item => item.passed),
    baselineId: baseline.id,
    sampleCheck,
    passed: comparisons.filter(item => item.passed).length,
    failed: comparisons.filter(item => !item.passed).length,
    comparisons
  };
}

export async function writePerformanceBaseline(context, {
  workspaceId,
  projectSubpath,
  baselineId = 'default',
  reportPath = 'artifacts/godot-performance/latest.json',
  baselinePath,
  warmupMs = 1000,
  force = false
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const id = safeId(baselineId);
  const reportRelative = safeRelative(reportPath, 'artifacts/godot-performance/latest.json');
  const baselineRelative = safeGodotBaselinePath(baselinePath, `.devmate/baselines/godot/${id}.json`);
  const reportFile = context.workspace.resolve(project.workspace, path.join(project.subpath, reportRelative), { mustExist: true });
  const baselineFile = context.workspace.resolve(project.workspace, path.join(project.subpath, baselineRelative));
  if (fs.statSync(baselineFile, { throwIfNoEntry: false })?.isFile() && !force) throw new Error(`Godot performance baseline already exists: ${baselineRelative}; set force=true to replace it`);
  const report = await readJson(reportFile);
  const summary = summarizePerformance(report, { warmupMs });
  const baseline = createPerformanceBaseline(summary, {
    id,
    scene: report?.runtime?.scene || null,
    engineVersion: report?.runtime?.engine_version || null,
    sourceReport: reportRelative
  });
  await fsp.mkdir(path.dirname(baselineFile), { recursive: true });
  let backupPath = null;
  if (fs.statSync(baselineFile, { throwIfNoEntry: false })?.isFile()) {
    const backup = `${baselineFile}.${Date.now()}.bak`;
    await fsp.copyFile(baselineFile, backup);
    backupPath = path.relative(project.workspace.root, backup).replace(/\\/g, '/');
  }
  const temporary = `${baselineFile}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, baselineFile);
  return {
    changed: true,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    baselinePath: path.relative(project.workspace.root, baselineFile).replace(/\\/g, '/'),
    backupPath,
    baseline
  };
}

export async function readPerformanceBaseline(context, { workspaceId, projectSubpath, baselineId = 'default', baselinePath } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const id = safeId(baselineId);
  const relative = safeGodotBaselinePath(baselinePath, `.devmate/baselines/godot/${id}.json`);
  const file = context.workspace.resolve(project.workspace, path.join(project.subpath, relative), { mustExist: true });
  const baseline = await readJson(file, 1024 * 1024);
  return { project, relative: path.relative(project.workspace.root, file).replace(/\\/g, '/'), baseline };
}

export const __test = { BASELINE_SCHEMA_VERSION, METRIC_POINTS, metricSnapshot, percentageChange, safeId, safeRelative };
