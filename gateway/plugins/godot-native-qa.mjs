import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { compareQaValue, stateValueAtPath } from './browser-runner.mjs';
import { inspectQaBridge } from './godot-qa-bridge.mjs';
import { normalizeScene, parseGodotDiagnostics, projectMetadata, resolveGodotExecutable, resolveProject } from './godot-project.mjs';

function safeRelative(value, fallback) {
  const relative = String(value || fallback || '').trim().replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Godot native QA path must stay inside the project workspace');
  return relative;
}

function normalizeInputActions(actions = [], knownActions = []) {
  const known = new Set(knownActions);
  const output = [];
  for (const item of actions) {
    const action = String(item.action || '').trim();
    if (!action) throw new Error('Godot native input action requires action');
    if (known.size && !known.has(action)) throw new Error(`Godot input action is not defined in project.godot: ${action}`);
    const atMs = Math.min(300000, Math.max(0, Math.trunc(Number(item.atMs) || 0)));
    const strength = Math.min(1, Math.max(0, Number(item.strength ?? 1)));
    if (item.type === 'tap') {
      const durationMs = Math.min(30000, Math.max(1, Math.trunc(Number(item.durationMs) || 100)));
      output.push({ at_ms: atMs, type: 'press', action, strength });
      output.push({ at_ms: atMs + durationMs, type: 'release', action, strength: 0 });
    } else {
      output.push({ at_ms: atMs, type: item.type || 'press', action, strength });
    }
  }
  return output.sort((a, b) => a.at_ms - b.at_ms || a.type.localeCompare(b.type));
}

function checkpointNames(report) {
  return Array.isArray(report?.checkpoints) ? report.checkpoints.map(item => String(item?.name || '')).filter(Boolean) : [];
}

function evaluateAssertions(report, assertions = []) {
  return assertions.map(assertion => {
    const operator = assertion.operator || 'eq';
    const actual = stateValueAtPath(report, assertion.statePath || '');
    const passed = compareQaValue(actual, operator, assertion.value);
    return { statePath: assertion.statePath || '', operator, expected: assertion.value, actual, passed };
  });
}

export async function runNativeQa(context, {
  workspaceId,
  projectSubpath,
  scene,
  headless = true,
  runForMs = 3000,
  quitOnCheckpoint = '',
  inputActions = [],
  assertions = [],
  requiredCheckpoints = [],
  reportPath = 'artifacts/godot-qa/native-latest.json',
  timeoutMs
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const bridge = await inspectQaBridge(project.root);
  if (!bridge.current) throw new Error(`Godot QA Bridge v${bridge.expectedVersion} is required. Run godot_qa_bridge_install first.`);
  const executable = resolveGodotExecutable(context);
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  const metadata = projectMetadata(projectText);
  const relativeReport = safeRelative(reportPath, 'artifacts/godot-qa/native-latest.json');
  const reportFile = context.workspace.resolve(project.workspace, path.join(project.subpath, relativeReport));
  await fsp.mkdir(path.dirname(reportFile), { recursive: true });
  await fsp.rm(reportFile, { force: true });

  const plan = normalizeInputActions(inputActions, metadata.inputActions);
  const runtimeDirectory = path.join(project.root, '.godot', 'devmate-qa');
  const planFile = path.join(runtimeDirectory, `plan-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.json`);
  if (plan.length) {
    await fsp.mkdir(runtimeDirectory, { recursive: true });
    await fsp.writeFile(planFile, `${JSON.stringify({ version: 1, actions: plan }, null, 2)}\n`, 'utf8');
  }

  const normalizedScene = normalizeScene(scene);
  const args = [];
  if (headless) args.push('--headless');
  args.push('--path', project.root);
  if (normalizedScene) args.push(normalizedScene);
  const boundedRunForMs = Math.min(300000, Math.max(250, Math.trunc(Number(runForMs) || 3000)));
  const environment = {
    DEVMATE_QA_REPORT: reportFile,
    DEVMATE_QA_AUTO_FINISH_MS: String(boundedRunForMs),
    DEVMATE_QA_QUIT_ON_CHECKPOINT: String(quitOnCheckpoint || '')
  };
  if (plan.length) environment.DEVMATE_QA_PLAN = planFile;

  let result;
  try {
    result = await context.executables.run(executable, args, {
      cwd: project.root,
      environment,
      timeoutMs: timeoutMs || Math.min(600000, Math.max(30000, boundedRunForMs + 30000)),
      maxOutputChars: 300000
    });
  } finally {
    if (plan.length) await fsp.rm(planFile, { force: true }).catch(() => {});
  }

  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  let report = null;
  let reportError = null;
  if (fs.statSync(reportFile, { throwIfNoEntry: false })?.isFile()) {
    try { report = JSON.parse(await fsp.readFile(reportFile, 'utf8')); }
    catch (error) { reportError = error.message; }
  }
  const assertionResults = report ? evaluateAssertions(report, assertions) : [];
  const names = checkpointNames(report);
  const missingCheckpoints = requiredCheckpoints.filter(name => !names.includes(name));
  const checks = {
    reportExists: !!report,
    reportValid: !!report && !reportError,
    bridgeReady: report?.runtime?.bridge_ready === true,
    bridgeVersion: Number(report?.runtime?.bridge_version || 0) === bridge.expectedVersion,
    completed: report?.runtime?.completed === true,
    runtimeOk: report?.runtime?.ok !== false,
    assertionsPassed: assertionResults.every(item => item.passed),
    checkpointsPassed: missingCheckpoints.length === 0,
    noDiagnosticsErrors: diagnostics.every(item => item.severity !== 'error'),
    processSucceeded: result.exitCode === 0 && !result.timedOut
  };
  return {
    ok: Object.values(checks).every(Boolean),
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    scene: normalizedScene || metadata.mainScene,
    headless,
    executable,
    args,
    runForMs: boundedRunForMs,
    quitOnCheckpoint: quitOnCheckpoint || null,
    plannedInputActions: plan.length,
    reportPath: path.relative(project.workspace.root, reportFile).replace(/\\/g, '/'),
    report,
    reportError,
    assertionResults,
    requiredCheckpoints,
    missingCheckpoints,
    diagnostics,
    result,
    checks
  };
}

export const __test = { checkpointNames, evaluateAssertions, normalizeInputActions, safeRelative };
