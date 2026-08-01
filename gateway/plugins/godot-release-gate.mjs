import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveProject } from './godot-project.mjs';

const GATE_SCHEMA_VERSION = 1;

function safeRelative(value, label) {
  const relative = String(value || '').trim().replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error(`${label} path must stay inside the project workspace`);
  return relative;
}

async function readJsonEvidence(context, project, relative, label) {
  const safe = safeRelative(relative, label);
  const file = context.workspace.resolve(project.workspace, path.join(project.subpath, safe), { mustExist: true });
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} evidence is not a file: ${safe}`);
  if (stat.size > 16 * 1024 * 1024) throw new Error(`${label} evidence exceeds 16 MiB: ${safe}`);
  let data;
  try { data = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid ${label} JSON ${safe}: ${error.message}`); }
  return { path: path.relative(project.workspace.root, file).replace(/\\/g, '/'), data, modifiedAt: stat.mtime.toISOString() };
}

function finding(level, code, message, detail = {}) {
  return { level, code, message, ...detail };
}

function evidenceAgeHours(modifiedAt, now = Date.now()) {
  const time = Date.parse(modifiedAt);
  return Number.isFinite(time) ? Math.max(0, (now - time) / 3600000) : null;
}

function inspectQuality(data, policy) {
  const blockers = [];
  const warnings = [];
  if (data?.ok !== true) blockers.push(finding('error', 'quality_not_ready', 'Godot quality report is not ready.'));
  const errors = Number(data?.audit?.summary?.errors ?? data?.summary?.audit?.errors ?? 0);
  const warningsCount = Number(data?.audit?.summary?.warnings ?? data?.summary?.audit?.warnings ?? 0);
  const missing = Number(data?.graph?.summary?.missing ?? data?.summary?.graph?.missing ?? 0);
  const blocked = Number(data?.plan?.summary?.blocked ?? data?.summary?.automation?.blocked ?? 0);
  if (errors > Number(policy.maxAuditErrors || 0)) blockers.push(finding('error', 'audit_errors', `${errors} audit error(s) exceed the release policy.`, { actual: errors, allowed: Number(policy.maxAuditErrors || 0) }));
  if (missing > Number(policy.maxMissingDependencies || 0)) blockers.push(finding('error', 'missing_dependencies', `${missing} missing dependency reference(s) exceed the release policy.`, { actual: missing, allowed: Number(policy.maxMissingDependencies || 0) }));
  if (blocked > Number(policy.maxBlockedAutomation || 0)) blockers.push(finding('error', 'blocked_automation', `${blocked} automation item(s) remain blocked.`, { actual: blocked, allowed: Number(policy.maxBlockedAutomation || 0) }));
  if (warningsCount > Number(policy.maxAuditWarnings ?? Number.MAX_SAFE_INTEGER)) warnings.push(finding('warning', 'audit_warnings', `${warningsCount} audit warning(s) exceed the advisory threshold.`, { actual: warningsCount, allowed: Number(policy.maxAuditWarnings) }));
  return { blockers, warnings, summary: { errors, warnings: warningsCount, missingDependencies: missing, blockedAutomation: blocked } };
}

function inspectTest(data) {
  const junit = data?.junit || data?.result?.junit || null;
  const valid = junit && junit.valid !== false && Number(junit.tests || 0) > 0;
  const ok = valid && data?.ok === true && Number(junit.failures || 0) === 0 && Number(junit.errors || 0) === 0;
  const blockers = ok ? [] : [finding('error', 'tests_failed', 'Godot framework test evidence must contain valid non-empty JUnit results with no failures or errors.')];
  return {
    blockers,
    warnings: [],
    summary: junit ? { valid: junit.valid !== false, tests: Number(junit.tests || 0), failures: Number(junit.failures || 0), errors: Number(junit.errors || 0), skipped: Number(junit.skipped || 0) } : { valid: false, tests: 0, failures: null, errors: null, skipped: null }
  };
}

function inspectPerformance(data) {
  const regression = data?.regression || data?.performance?.regression || null;
  const budget = data?.performance?.budget || data?.budget || null;
  const samples = Number(data?.performance?.summary?.evaluatedSamples ?? data?.summary?.evaluatedSamples ?? 0);
  const ok = data?.ok === true && (!regression || regression.ok === true) && (!budget || budget.ok === true) && samples > 0;
  const blockers = ok ? [] : [finding('error', 'performance_failed', 'Performance evidence is missing samples, exceeds budgets, or regresses against its baseline.')];
  return { blockers, warnings: [], summary: { samples, regressionOk: regression?.ok ?? null, budgetOk: budget?.ok ?? null } };
}

function inspectExport(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const failed = Number(data?.failed ?? results.filter(item => item?.ok !== true).length);
  const completed = Number(data?.completed ?? results.length ?? 0);
  const ok = data?.ok === true && failed === 0 && completed > 0;
  return {
    blockers: ok ? [] : [finding('error', 'exports_failed', 'Export evidence is missing successful completed targets or contains failures.', { completed, failed })],
    warnings: [],
    summary: { completed, failed, passed: Number(data?.passed ?? Math.max(0, completed - failed)) }
  };
}

function inspectCapture(data) {
  const capture = data?.capture || null;
  const ok = data?.ok === true && capture?.exists === true && Number(capture.bytes || 0) > 0;
  return {
    blockers: ok ? [] : [finding('error', 'capture_failed', 'Required deterministic capture evidence is missing or empty.')],
    warnings: [],
    summary: capture ? { path: capture.path || null, bytes: Number(capture.bytes || 0), fps: capture.fps || null, frames: capture.frames || null } : null
  };
}

function inspector(type) {
  if (type === 'quality') return inspectQuality;
  if (type === 'tests') return inspectTest;
  if (type === 'performance') return inspectPerformance;
  if (type === 'exports') return inspectExport;
  if (type === 'capture') return inspectCapture;
  throw new Error(`Unsupported Godot release evidence type: ${type}`);
}

export async function evaluateGodotReleaseGate(context, {
  workspaceId,
  projectSubpath,
  evidence = [],
  policy = {},
  reportPath = 'artifacts/godot-release/gate.json'
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const normalizedPolicy = {
    maxAgeHours: Math.min(24 * 365, Math.max(0, Number(policy.maxAgeHours ?? 168))),
    maxAuditErrors: Math.max(0, Math.trunc(Number(policy.maxAuditErrors || 0))),
    maxAuditWarnings: policy.maxAuditWarnings == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.trunc(Number(policy.maxAuditWarnings))),
    maxMissingDependencies: Math.max(0, Math.trunc(Number(policy.maxMissingDependencies || 0))),
    maxBlockedAutomation: Math.max(0, Math.trunc(Number(policy.maxBlockedAutomation || 0))),
    requiredTypes: [...new Set((Array.isArray(policy.requiredTypes) ? policy.requiredTypes : ['quality', 'tests', 'performance', 'exports']).map(String))]
  };
  if (evidence.length > 50) throw new Error('Godot release gate accepts at most 50 evidence files');
  const loaded = [];
  const blockers = [];
  const warnings = [];
  for (const item of evidence) {
    const type = String(item?.type || '').trim();
    const pathValue = String(item?.path || '').trim();
    const read = await readJsonEvidence(context, project, pathValue, `${type || 'release'} evidence`);
    const ageHours = evidenceAgeHours(read.modifiedAt);
    const result = inspector(type)(read.data, normalizedPolicy);
    if (normalizedPolicy.maxAgeHours > 0 && ageHours != null && ageHours > normalizedPolicy.maxAgeHours) {
      result.blockers.push(finding('error', 'evidence_stale', `${type} evidence is ${ageHours.toFixed(1)} hours old.`, { ageHours, allowedHours: normalizedPolicy.maxAgeHours }));
    }
    blockers.push(...result.blockers.map(entry => ({ ...entry, evidenceType: type, evidencePath: read.path })));
    warnings.push(...result.warnings.map(entry => ({ ...entry, evidenceType: type, evidencePath: read.path })));
    loaded.push({ type, path: read.path, modifiedAt: read.modifiedAt, ageHours, ok: result.blockers.length === 0, summary: result.summary });
  }
  const presentTypes = new Set(loaded.map(item => item.type));
  for (const type of normalizedPolicy.requiredTypes) {
    if (!presentTypes.has(type)) blockers.push(finding('error', 'required_evidence_missing', `Required ${type} evidence was not provided.`, { evidenceType: type }));
  }
  const duplicateTypes = [...presentTypes].filter(type => loaded.filter(item => item.type === type).length > 1);
  if (duplicateTypes.length) warnings.push(finding('warning', 'duplicate_evidence_types', `Multiple evidence files were supplied for: ${duplicateTypes.join(', ')}.`));
  const gate = {
    schemaVersion: GATE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ok: blockers.length === 0,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    policy: normalizedPolicy,
    summary: { evidence: loaded.length, passed: loaded.filter(item => item.ok).length, failed: loaded.filter(item => !item.ok).length, blockers: blockers.length, warnings: warnings.length },
    evidence: loaded,
    blockers,
    warnings
  };
  const relative = safeRelative(reportPath, 'Godot release gate report');
  const file = context.workspace.resolve(project.workspace, path.join(project.subpath, relative));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(gate, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, file);
  return { ...gate, reportPath: path.relative(project.workspace.root, file).replace(/\\/g, '/'), artifactPaths: [path.relative(project.workspace.root, file).replace(/\\/g, '/')] };
}

export const __test = { GATE_SCHEMA_VERSION, evidenceAgeHours, inspectCapture, inspectExport, inspectPerformance, inspectQuality, inspectTest, safeRelative };
