import fsp from 'node:fs/promises';
import { loadAutomationManifest, pluginAutomationConfig, scenarioById } from './automation-manifest.mjs';
import { safeGodotRelativePath } from './godot-path-policy.mjs';
import { inspectQaBridge } from './godot-qa-bridge.mjs';
import { projectMetadata, readExportPresets, resolveProject } from './godot-project.mjs';

// How a plan item is run: directly with capability.call, or as a job because exports and tests can exceed a minute.
function invocation(capability, input) {
  return { capability, call: { capability, input }, job: { kind: 'capability', input: { capability, input } } };
}

function normalizeScenario(value = {}) {
  return {
    id: String(value.id || '').trim(),
    description: String(value.description || ''),
    kind: value.kind === 'native' ? 'native' : 'web',
    projectSubpath: value.projectSubpath,
    preset: value.preset,
    outputPath: value.outputPath,
    mode: value.mode,
    scene: value.scene,
    headless: value.headless,
    runForMs: value.runForMs,
    quitOnCheckpoint: value.quitOnCheckpoint,
    inputActions: Array.isArray(value.inputActions) ? value.inputActions : [],
    assertions: Array.isArray(value.assertions) ? value.assertions : [],
    requiredCheckpoints: Array.isArray(value.requiredCheckpoints) ? value.requiredCheckpoints : [],
    actions: Array.isArray(value.actions) ? value.actions : [],
    reportPath: value.reportPath,
    screenshotPath: value.screenshotPath
  };
}

function normalizeExport(value = {}) {
  return {
    preset: String(value.preset || '').trim(),
    outputPath: value.outputPath,
    mode: value.mode,
    timeoutMs: value.timeoutMs
  };
}

function issue(level, code, message, data = {}) {
  return { level, code, message, ...data };
}

function pathBlocker(value, label, scenarioId = null) {
  if (!value) return null;
  try {
    safeGodotRelativePath(value, '', label);
    return null;
  } catch (error) {
    return issue('error', 'unsafe_automation_path', `${label} is unsafe: ${error.message}`, {
      ...(scenarioId ? { scenarioId } : {}),
      path: String(value)
    });
  }
}

function exportPlanItem(target, preset, config) {
  const mode = target.mode || config.exportMode || 'release';
  const args = {
    projectSubpath: config.projectSubpath || '.',
    preset: target.preset,
    mode
  };
  if (target.outputPath) args.outputPath = target.outputPath;
  const blockers = preset ? [] : [issue('error', 'unknown_export_preset', `Godot export preset not found: ${target.preset}`, { preset: target.preset })];
  const outputBlocker = pathBlocker(target.outputPath, 'Godot export outputPath');
  if (outputBlocker) blockers.push(outputBlocker);
  const projectBlocker = pathBlocker(args.projectSubpath, 'Godot projectSubpath');
  if (projectBlocker) blockers.push(projectBlocker);
  return {
    id: `export:${target.preset}`,
    kind: 'export',
    preset: target.preset,
    platform: preset?.platform || null,
    mode,
    ...invocation('godot.export', args),
    blockers,
    warnings: []
  };
}

function scenarioPlanItem(scenario, config, presets, metadata, bridge) {
  const blockers = [];
  const warnings = [];
  const kind = scenario.kind || 'web';
  let capability;
  let args;
  if (kind === 'native') {
    capability = 'godot.native_test';
    args = {
      projectSubpath: scenario.projectSubpath || config.projectSubpath || '.',
      scene: scenario.scene,
      headless: scenario.headless !== false,
      runForMs: scenario.runForMs || 3000,
      quitOnCheckpoint: scenario.quitOnCheckpoint || '',
      inputActions: scenario.inputActions || [],
      assertions: scenario.assertions || [],
      requiredCheckpoints: scenario.requiredCheckpoints || [],
      reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}-native.json`
    };
    if (!bridge.current) blockers.push(issue('error', 'qa_bridge_required', 'Native Godot acceptance requires the current DevMate QA Bridge. Install it with godot.qa_bridge_install.', { scenarioId: scenario.id }));
    const knownActions = new Set(metadata.inputActions || []);
    for (const action of scenario.inputActions || []) {
      if (!knownActions.has(String(action.action || ''))) {
        blockers.push(issue('error', 'unknown_input_action', `Input action is not declared in project.godot: ${action.action || '(empty)'}`, { scenarioId: scenario.id, action: action.action || null }));
      }
    }
    if (!(scenario.assertions || []).length && !(scenario.requiredCheckpoints || []).length && !scenario.quitOnCheckpoint) {
      warnings.push(issue('warning', 'weak_native_acceptance', 'Native scenario has no state assertions or required checkpoints.', { scenarioId: scenario.id }));
    }
    for (const [value, label] of [[args.projectSubpath, 'Godot projectSubpath'], [args.reportPath, 'Godot native reportPath']]) {
      const blocker = pathBlocker(value, label, scenario.id);
      if (blocker) blockers.push(blocker);
    }
  } else {
    const presetName = scenario.preset || config.preset || 'Web';
    const preset = presets.find(item => item.name === presetName);
    capability = 'godot.acceptance_test';
    args = {
      projectSubpath: scenario.projectSubpath || config.projectSubpath || '.',
      preset: presetName,
      outputPath: scenario.outputPath || config.outputPath || 'build/web/index.html',
      mode: scenario.mode || config.mode || 'debug',
      actions: scenario.actions || [],
      screenshotPath: scenario.screenshotPath || `artifacts/godot-qa/${scenario.id}.png`,
      reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}.json`
    };
    if (!preset) blockers.push(issue('error', 'unknown_web_preset', `Web acceptance preset not found: ${presetName}`, { scenarioId: scenario.id, preset: presetName }));
    else if (!/web/i.test(`${preset.name} ${preset.platform}`)) blockers.push(issue('error', 'non_web_preset', `Acceptance preset is not a Web preset: ${presetName}`, { scenarioId: scenario.id, preset: presetName }));
    if (!(scenario.actions || []).length) warnings.push(issue('warning', 'empty_web_actions', 'Web scenario has no browser or state actions.', { scenarioId: scenario.id }));
    for (const [value, label] of [
      [args.projectSubpath, 'Godot projectSubpath'],
      [args.outputPath, 'Godot Web outputPath'],
      [args.screenshotPath, 'Godot Web screenshotPath'],
      [args.reportPath, 'Godot Web reportPath']
    ]) {
      const blocker = pathBlocker(value, label, scenario.id);
      if (blocker) blockers.push(blocker);
    }
  }
  return {
    id: `scenario:${scenario.id}`,
    kind,
    scenarioId: scenario.id,
    description: scenario.description || '',
    ...invocation(capability, args),
    blockers,
    warnings
  };
}

export async function planGodotAutomation(context, {
  workspaceId,
  projectSubpath,
  manifestPath,
  scenarioIds = [],
  exportPresets = []
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const projectText = await fsp.readFile(project.projectFile, 'utf8');
  const metadata = projectMetadata(projectText);
  const presets = await readExportPresets(project.root);
  const bridge = await inspectQaBridge(project.root);
  const entries = await fsp.readdir(project.root).catch(() => []);
  const csharpProject = entries.some(name => /\.(?:csproj|sln)$/i.test(name));
  const loaded = await loadAutomationManifest(context, { workspaceId: project.workspace.id, manifestPath, required: false });
  const raw = loaded.exists ? pluginAutomationConfig(loaded.manifest, 'devmate.godot') : {};
  const config = {
    projectSubpath: raw.projectSubpath || project.subpath || '.',
    preset: raw.preset || 'Web',
    outputPath: raw.outputPath || 'build/web/index.html',
    mode: raw.mode || 'debug',
    exportMode: raw.exportMode || 'release',
    exports: Array.isArray(raw.exports) ? raw.exports.map(normalizeExport).filter(item => item.preset) : [],
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map(normalizeScenario).filter(item => item.id) : []
  };
  const selectedScenarios = scenarioIds.length
    ? scenarioIds.map(id => normalizeScenario(scenarioById(config.scenarios, id)))
    : config.scenarios;
  const selectedExports = exportPresets.length
    ? exportPresets.map(preset => ({ preset }))
    : config.exports;
  const items = [];
  for (const target of selectedExports) {
    items.push(exportPlanItem(target, presets.find(item => item.name === target.preset), config));
  }
  for (const scenario of selectedScenarios) items.push(scenarioPlanItem(scenario, config, presets, metadata, bridge));
  const blockers = items.flatMap(item => item.blockers);
  const warnings = items.flatMap(item => item.warnings);
  return {
    ok: blockers.length === 0,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    manifestPath: loaded.manifestPath,
    manifestExists: loaded.exists,
    project: {
      name: metadata.name,
      mainScene: metadata.mainScene,
      inputActions: metadata.inputActions,
      csharp: csharpProject,
      qaBridge: bridge
    },
    presets,
    selected: { exports: selectedExports.length, scenarios: selectedScenarios.length },
    summary: {
      items: items.length,
      ready: items.filter(item => item.blockers.length === 0).length,
      blocked: items.filter(item => item.blockers.length > 0).length,
      warnings: warnings.length
    },
    blockers,
    warnings,
    items
  };
}

export const __test = { exportPlanItem, normalizeExport, normalizeScenario, pathBlocker, scenarioPlanItem };
