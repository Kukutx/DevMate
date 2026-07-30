import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { browserActionSchema, browserViewportSchema } from './browser-schemas.mjs';
import { loadAutomationManifest, pluginAutomationConfig, scenarioById } from './automation-manifest.mjs';
import { auditGodotProject } from './godot-audit.mjs';
import { installQaBridge, inspectQaBridge, qaBridgeTemplate, removeQaBridge } from './godot-qa-bridge.mjs';
import { runNativeQa } from './godot-native-qa.mjs';
import {
  exportMatrix, exportProject, exportWeb, inspectProject, normalizeScene, parseGodotConfig,
  parseExportPresets, parseGodotDiagnostics, projectMetadata, resolveGodotExecutable,
  resolveProject, validateProject
} from './godot-project.mjs';

const settingsSchema = z.object({
  executablePath: z.string().max(2000).optional(),
  defaultProjectSubpath: z.string().max(1000).optional(),
  defaultWebPreset: z.string().max(200).optional(),
  defaultWebOutput: z.string().max(1000).optional(),
  defaultExportRoot: z.string().max(1000).optional(),
  validationTimeoutMs: z.number().int().min(1000).max(1800000).optional(),
  exportTimeoutMs: z.number().int().min(1000).max(1800000).optional()
}).strict();

export const godotStateAssertionSchema = z.object({
  statePath: z.string().max(1000).default(''),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes', 'truthy', 'falsy']).default('eq'),
  value: z.unknown().optional()
}).strict();

export const godotNativeInputSchema = z.object({
  atMs: z.number().int().min(0).max(300000),
  type: z.enum(['press', 'release', 'tap']).default('tap'),
  action: z.string().min(1).max(200),
  durationMs: z.number().int().min(1).max(30000).optional(),
  strength: z.number().min(0).max(1).optional()
}).strict();

export const godotExportTargetSchema = z.object({
  preset: z.string().min(1).max(200),
  outputPath: z.string().max(1000).optional(),
  mode: z.enum(['debug', 'release']).optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).optional()
}).strict();

export const godotScenarioSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  description: z.string().max(1000).optional(),
  kind: z.enum(['web', 'native']).optional(),
  projectSubpath: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).optional(),
  reportPath: z.string().max(1000).optional(),

  preset: z.string().max(200).optional(),
  outputPath: z.string().max(1000).optional(),
  mode: z.enum(['debug', 'release']).optional(),
  actions: z.array(browserActionSchema).max(100).optional(),
  screenshotPath: z.string().max(1000).optional(),
  viewport: browserViewportSchema.optional(),
  crossOriginIsolation: z.boolean().optional(),

  scene: z.string().max(1000).optional(),
  headless: z.boolean().optional(),
  runForMs: z.number().int().min(250).max(300000).optional(),
  quitOnCheckpoint: z.string().max(200).optional(),
  inputActions: z.array(godotNativeInputSchema).max(100).optional(),
  assertions: z.array(godotStateAssertionSchema).max(100).optional(),
  requiredCheckpoints: z.array(z.string().min(1).max(200)).max(100).optional()
}).strict();

const godotAutomationConfigSchema = z.object({
  projectSubpath: z.string().max(1000).default('.'),
  preset: z.string().max(200).default('Web'),
  outputPath: z.string().max(1000).default('build/web/index.html'),
  mode: z.enum(['debug', 'release']).default('debug'),
  exportMode: z.enum(['debug', 'release']).default('release'),
  exportOutputRoot: z.string().max(1000).default('build/exports'),
  exports: z.array(godotExportTargetSchema).max(20).default([]),
  scenarios: z.array(godotScenarioSchema).max(100).default([])
}).strict();

function browserService(context) {
  return context.services.get('devmate.browser-qa');
}

async function acceptanceTest(context, {
  workspaceId,
  projectSubpath,
  preset,
  outputPath,
  mode = 'debug',
  actions = [],
  screenshotPath = 'artifacts/godot-qa/latest.png',
  reportPath = 'artifacts/godot-qa/latest.json',
  timeoutMs,
  viewport = {},
  crossOriginIsolation = false
}) {
  const browser = browserService(context);
  const validation = await validateProject(context, { workspaceId, projectSubpath, timeoutMs });
  if (!validation.ok) return { ok: false, stage: 'validation', validation, export: null, browser: null };
  const exported = await exportWeb(context, {
    workspaceId,
    projectSubpath,
    preset,
    outputPath,
    mode,
    timeoutMs,
    startLocalPreview: true,
    crossOriginIsolation
  }, browser);
  if (!exported.ok || !exported.preview) return { ok: false, stage: 'export', validation, export: exported, browser: null };
  const workspace = context.workspace.get(workspaceId, { writable: true });
  let browserResult;
  try {
    browserResult = await browser.runScenario({
      workspaceRoot: workspace.root,
      url: exported.preview.url,
      actions,
      screenshotPath,
      reportPath,
      timeoutMs: Math.min(120000, timeoutMs || 60000),
      viewport
    });
  } catch (error) {
    return { ok: false, stage: 'browser_setup', validation, export: exported, browser: null, error: error.message || String(error) };
  }
  const visibleCanvas = browserResult.pageState?.canvases?.some(item => item.visible && item.clientWidth > 0 && item.clientHeight > 0);
  const ok = validation.ok && exported.ok && browserResult.ok && visibleCanvas;
  return {
    ok,
    stage: ok ? 'complete' : 'browser',
    validation,
    export: exported,
    browser: browserResult,
    checks: {
      visibleCanvas: !!visibleCanvas,
      qaStateAvailable: browserResult.pageState?.qaState != null,
      noNavigationError: !browserResult.navigationError,
      noActionError: !browserResult.actionError,
      noPageErrors: browserResult.pageErrors.length === 0,
      noConsoleErrors: browserResult.consoleErrors.length === 0,
      noRequestFailures: browserResult.requestFailures.length === 0
    }
  };
}

async function loadGodotAutomation(context, { workspaceId, manifestPath, required = true } = {}) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required });
  if (!loaded.exists) return { ...loaded, config: null };
  const config = godotAutomationConfigSchema.parse(pluginAutomationConfig(loaded.manifest, 'devmate.godot'));
  const ids = new Set();
  for (const scenario of config.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate Godot automation scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return { ...loaded, config };
}

function mergeScenarioConfig(config, scenario) {
  const kind = scenario.kind || 'web';
  if (kind === 'native') {
    return {
      kind,
      projectSubpath: scenario.projectSubpath || config.projectSubpath,
      scene: scenario.scene,
      headless: scenario.headless !== false,
      runForMs: scenario.runForMs || 3000,
      quitOnCheckpoint: scenario.quitOnCheckpoint || '',
      inputActions: scenario.inputActions || [],
      assertions: scenario.assertions || [],
      requiredCheckpoints: scenario.requiredCheckpoints || [],
      reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}-native.json`,
      timeoutMs: scenario.timeoutMs
    };
  }
  return {
    kind,
    projectSubpath: scenario.projectSubpath || config.projectSubpath,
    preset: scenario.preset || config.preset,
    outputPath: scenario.outputPath || config.outputPath,
    mode: scenario.mode || config.mode,
    actions: scenario.actions || [],
    screenshotPath: scenario.screenshotPath || `artifacts/godot-qa/${scenario.id}.png`,
    reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}.json`,
    timeoutMs: scenario.timeoutMs,
    viewport: scenario.viewport || {},
    crossOriginIsolation: !!scenario.crossOriginIsolation
  };
}

async function runSavedScenario(context, workspaceId, config, scenario) {
  const merged = mergeScenarioConfig(config, scenario);
  return merged.kind === 'native'
    ? runNativeQa(context, { workspaceId, ...merged })
    : acceptanceTest(context, { workspaceId, ...merged });
}

export const godotPlugin = definePlugin({
  manifest: {
    id: 'devmate.godot',
    name: 'Godot Development',
    version: '0.3.0',
    apiVersion: '1',
    description: 'Godot project audit, validation, native/Web acceptance, supervised execution, and multi-platform export orchestration.',
    defaultEnabled: false,
    dependencies: ['devmate.browser-qa'],
    consumes: ['devmate.browser-qa'],
    toolPrefixes: ['godot_'],
    capabilities: ['tools', 'workspace-read', 'workspace-write', 'processes', 'project-audit', 'export-matrix', 'native-qa', 'web-export', 'browser-qa', 'automation-manifest', 'structured-state'],
    permissions: { executablePatterns: ['^godot(?:4)?(?:[._-].*)?(?:\\.exe)?$'] }
  },
  settingsSchema,
  defaultSettings: {
    executablePath: '',
    defaultProjectSubpath: '.',
    defaultWebPreset: 'Web',
    defaultWebOutput: 'build/web/index.html',
    defaultExportRoot: 'build/exports',
    validationTimeoutMs: 300000,
    exportTimeoutMs: 600000
  },
  async diagnose(context) {
    let executable = null;
    try { executable = resolveGodotExecutable(context); } catch {}
    let project = null;
    try { project = await inspectProject(context); } catch (error) { project = { error: error.message }; }
    let audit = null;
    try { audit = await auditGodotProject(context); } catch (error) { audit = { error: error.message }; }
    let browser = null;
    try {
      const workspace = context.workspace.get(undefined, { writable: false });
      browser = browserService(context).status(workspace.root);
    } catch (error) { browser = { error: error.message }; }
    return { executable, project, audit, browser };
  },
  activate(context) {
    const { server } = context;

    server.registerTool('godot_status', {
      title: 'Godot capability status',
      description: 'Inspect the active Godot project, export presets, input actions, Autoloads, QA bridge, project metadata, and configured executable without launching Godot.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, projectSubpath }) => {
      const inspection = await inspectProject(context, workspaceId, projectSubpath);
      const project = resolveProject(context, workspaceId, projectSubpath);
      const qaBridge = await inspectQaBridge(project.root);
      let executable = null;
      let executableError = null;
      try { executable = resolveGodotExecutable(context); } catch (error) { executableError = error.message; }
      return context.toolText({ ...inspection, qaBridge, executable, executableError, settings: context.settings });
    });

    server.registerTool('godot_project_audit', {
      title: 'Audit Godot project',
      description: 'Run a bounded static project audit covering main scene, resource references, Autoloads, input actions, C# setup, renderer, export presets, addons, and QA readiness.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), maxFiles: z.number().int().min(100).max(10000).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => context.toolText(await auditGodotProject(context, args)));

    server.registerTool('godot_doctor', {
      title: 'Godot doctor',
      description: 'Run Godot --version and combine executable, project audit, export, QA bridge, and Browser QA readiness.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, timeoutMs = 15000 }) => {
      const audit = await auditGodotProject(context, { workspaceId, projectSubpath });
      const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
      const executable = resolveGodotExecutable(context);
      const version = await context.executables.run(executable, ['--version'], { cwd: project.root, timeoutMs, maxOutputChars: 20000 });
      const browser = browserService(context).status(project.workspace.root);
      const webPresets = audit.presets.filter(item => /web/i.test(item.platform) || /web/i.test(item.name));
      return context.toolText({
        executable,
        version,
        audit,
        browserQa: browser,
        ready: version.exitCode === 0 && audit.summary.errors === 0,
        exportReady: version.exitCode === 0 && audit.readiness.exportable,
        nativeQaReady: version.exitCode === 0 && audit.readiness.nativeAcceptance,
        webQaReady: version.exitCode === 0 && webPresets.length > 0 && browser.available && audit.qaBridge.current
      });
    });

    server.registerTool('godot_qa_bridge_status', {
      title: 'Godot QA bridge status',
      description: 'Check whether the DevMateQA Autoload bridge is installed, current, and configured in the selected Godot project.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, projectSubpath }) => {
      const project = resolveProject(context, workspaceId, projectSubpath);
      return context.toolText({ workspace: { id: project.workspace.id, name: project.workspace.name }, projectSubpath: project.subpath, qaBridge: await inspectQaBridge(project.root) });
    });

    server.registerTool('godot_qa_bridge_template', {
      title: 'Godot QA bridge template',
      description: 'Return the reviewed DevMateQA GDScript template, Autoload entry, native reporting behavior, and usage examples.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async () => context.toolText(qaBridgeTemplate()));

    server.registerTool('godot_qa_bridge_install', {
      title: 'Install or upgrade Godot QA bridge',
      description: 'Install or upgrade the reviewed DevMateQA Autoload bridge atomically, with project-local backups under .godot/devmate-backups.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), force: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async args => {
      const result = await installQaBridge(context, args);
      await context.audit('qa_bridge_install', { workspace: result.workspace?.id, projectSubpath: result.projectSubpath, changed: result.changed, backups: result.backups });
      return context.toolText(result);
    });

    server.registerTool('godot_qa_bridge_remove', {
      title: 'Remove Godot QA bridge',
      description: 'Remove the DevMateQA Autoload entry and optionally its script, with project-local backups before mutation.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), removeScript: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async args => {
      const result = await removeQaBridge(context, args);
      await context.audit('qa_bridge_remove', { workspace: result.workspace?.id, projectSubpath: result.projectSubpath, changed: result.changed, backups: result.backups });
      return context.toolText(result);
    });

    server.registerTool('godot_validate', {
      title: 'Validate Godot project',
      description: 'Run a headless Godot editor import/parse pass and return structured errors and warnings.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), timeoutMs: z.number().int().min(1000).max(1800000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const validation = await validateProject(context, args);
      await context.audit('validate', { workspace: validation.workspace.id, projectSubpath: validation.projectSubpath, ok: validation.ok, exitCode: validation.result.exitCode });
      return context.toolText(validation);
    });

    server.registerTool('godot_run', {
      title: 'Run Godot project',
      description: 'Start a persistent Godot game, scene, or editor process that can be inspected and stopped through DevMate process tools.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        editor: z.boolean().optional(),
        headless: z.boolean().optional(),
        scene: z.string().optional(),
        autoStopAfterMs: z.number().int().min(1000).max(86400000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, editor = false, headless = false, scene, autoStopAfterMs }) => {
      const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
      const executable = resolveGodotExecutable(context);
      const args = [];
      if (headless) args.push('--headless');
      if (editor) args.push('--editor');
      args.push('--path', project.root);
      const normalizedScene = normalizeScene(scene);
      if (normalizedScene) args.push(normalizedScene);
      const processRecord = await context.executables.start(executable, args, {
        workspaceId: project.workspace.id,
        cwd: project.subpath,
        label: editor ? 'Godot editor' : normalizedScene ? `Godot scene ${normalizedScene}` : 'Godot game',
        autoStopAfterMs
      });
      await context.audit('run', { workspace: project.workspace.id, projectSubpath: project.subpath, processId: processRecord.id, editor, headless, scene: normalizedScene });
      return context.toolText({ process: processRecord, executable, args });
    });

    server.registerTool('godot_export', {
      title: 'Export Godot preset',
      description: 'Export any configured Godot preset for desktop, mobile, Web, dedicated server, or custom targets and return artifact metadata.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        preset: z.string().optional(),
        outputPath: z.string().optional(),
        outputRoot: z.string().optional(),
        mode: z.enum(['debug', 'release']).optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const exported = await exportProject(context, args);
      await context.audit('export', { workspace: exported.workspace.id, projectSubpath: exported.projectSubpath, preset: exported.preset, outputPath: exported.outputPath, ok: exported.ok });
      return context.toolText(exported);
    });

    server.registerTool('godot_export_matrix', {
      title: 'Export Godot matrix',
      description: 'Export selected or all Godot presets sequentially, with generated safe output paths, stop-on-failure behavior, artifact metadata, and an optional JSON report.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        manifestPath: z.string().optional(),
        targets: z.array(godotExportTargetSchema).max(20).optional(),
        mode: z.enum(['debug', 'release']).optional(),
        outputRoot: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
        stopOnFailure: z.boolean().optional(),
        reportPath: z.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      let options = { mode: 'release', stopOnFailure: true, ...args };
      if ((!args.targets || args.targets.length === 0) && args.manifestPath) {
        const loaded = await loadGodotAutomation(context, { workspaceId: args.workspaceId, manifestPath: args.manifestPath });
        options = {
          ...options,
          projectSubpath: args.projectSubpath || loaded.config.projectSubpath,
          targets: loaded.config.exports,
          mode: args.mode || loaded.config.exportMode,
          outputRoot: args.outputRoot || loaded.config.exportOutputRoot
        };
      }
      const matrix = await exportMatrix(context, options);
      await context.audit('export_matrix', { workspace: matrix.workspace.id, projectSubpath: matrix.projectSubpath, requested: matrix.requested, passed: matrix.passed, ok: matrix.ok, reportPath: matrix.reportPath });
      return context.toolText(matrix);
    });

    server.registerTool('godot_export_web', {
      title: 'Export Godot Web build',
      description: 'Validate Web export inputs, run a Godot Web export, and optionally start a local HTTP preview URL.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        preset: z.string().optional(),
        outputPath: z.string().optional(),
        mode: z.enum(['debug', 'release']).optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
        startLocalPreview: z.boolean().optional(),
        crossOriginIsolation: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const exported = await exportWeb(context, { mode: 'debug', startLocalPreview: true, ...args }, browserService(context));
      await context.audit('export_web', { workspace: exported.workspace.id, projectSubpath: exported.projectSubpath, preset: exported.preset, outputPath: exported.outputPath, ok: exported.ok, previewId: exported.preview?.id });
      return context.toolText(exported);
    });

    server.registerTool('godot_native_test', {
      title: 'Run native Godot acceptance test',
      description: 'Launch a Godot scene or project with QA Bridge v2, replay bounded Input actions, capture a native JSON state report, assert final state/checkpoints, and return a deterministic pass/fail result.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        scene: z.string().optional(),
        headless: z.boolean().optional(),
        runForMs: z.number().int().min(250).max(300000).optional(),
        quitOnCheckpoint: z.string().max(200).optional(),
        inputActions: z.array(godotNativeInputSchema).max(100).optional(),
        assertions: z.array(godotStateAssertionSchema).max(100).optional(),
        requiredCheckpoints: z.array(z.string().min(1).max(200)).max(100).optional(),
        reportPath: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(600000).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const report = await runNativeQa(context, args);
      await context.audit('native_test', { workspace: report.workspace.id, projectSubpath: report.projectSubpath, scene: report.scene, ok: report.ok, reportPath: report.reportPath });
      return context.toolText(report);
    });

    server.registerTool('godot_automation_manifest', {
      title: 'Godot saved exports and acceptance scenarios',
      description: 'Read and validate version-controlled Godot export targets plus Web/native acceptance scenarios from .devmate/automation.json.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async args => {
      const loaded = await loadGodotAutomation(context, { ...args, required: false });
      return context.toolText({ workspace: loaded.workspace, manifestPath: loaded.manifestPath, exists: loaded.exists, config: loaded.config });
    });

    server.registerTool('godot_acceptance_test', {
      title: 'Run Godot Web acceptance test',
      description: 'Run Godot validation, export a Web build, start a local preview, execute bounded browser/state actions, capture artifacts, and return a combined pass/fail report.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        preset: z.string().optional(),
        outputPath: z.string().optional(),
        mode: z.enum(['debug', 'release']).optional(),
        actions: z.array(browserActionSchema).max(100).optional(),
        screenshotPath: z.string().optional(),
        reportPath: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
        viewport: browserViewportSchema.optional(),
        crossOriginIsolation: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      const report = await acceptanceTest(context, args);
      await context.audit('acceptance_test', { workspace: report.validation?.workspace?.id, projectSubpath: report.validation?.projectSubpath, ok: report.ok, stage: report.stage, screenshotPath: report.browser?.screenshotPath, reportPath: report.browser?.reportPath });
      return context.toolText(report);
    });

    server.registerTool('godot_acceptance_run_saved', {
      title: 'Run saved Godot acceptance scenario',
      description: 'Run one version-controlled Web or native Godot acceptance scenario from .devmate/automation.json.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().optional(), scenarioId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, manifestPath, scenarioId }) => {
      const loaded = await loadGodotAutomation(context, { workspaceId, manifestPath });
      const scenario = godotScenarioSchema.parse(scenarioById(loaded.config.scenarios, scenarioId));
      const report = await runSavedScenario(context, workspaceId, loaded.config, scenario);
      await context.audit('acceptance_run_saved', { workspace: report.workspace?.id || report.validation?.workspace?.id, scenarioId, kind: scenario.kind || 'web', ok: report.ok, stage: report.stage });
      return context.toolText({ manifestPath: loaded.manifestPath, scenario, report });
    });

    server.registerTool('godot_acceptance_suite', {
      title: 'Run saved Godot acceptance suite',
      description: 'Run selected or all version-controlled Web/native Godot acceptance scenarios and return an aggregate report.',
      inputSchema: {
        workspaceId: z.string().optional(),
        manifestPath: z.string().optional(),
        scenarioIds: z.array(z.string().min(1)).max(50).optional(),
        stopOnFailure: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, manifestPath, scenarioIds = [], stopOnFailure = true }) => {
      const loaded = await loadGodotAutomation(context, { workspaceId, manifestPath });
      const selected = scenarioIds.length
        ? scenarioIds.map(id => godotScenarioSchema.parse(scenarioById(loaded.config.scenarios, id)))
        : loaded.config.scenarios;
      if (selected.length === 0) throw new Error('No Godot acceptance scenarios are configured');
      const results = [];
      for (const scenario of selected) {
        const report = await runSavedScenario(context, workspaceId, loaded.config, scenario);
        results.push({ id: scenario.id, kind: scenario.kind || 'web', description: scenario.description || '', report });
        if (!report.ok && stopOnFailure) break;
      }
      const passed = results.filter(item => item.report.ok).length;
      const suite = { ok: passed === selected.length && results.length === selected.length, manifestPath: loaded.manifestPath, requested: selected.length, completed: results.length, passed, failed: results.length - passed, stoppedEarly: results.length < selected.length, results };
      await context.audit('acceptance_suite', { workspace: loaded.workspace.id, requested: selected.length, completed: results.length, passed, ok: suite.ok });
      return context.toolText(suite);
    });
  }
});

export { parseGodotConfig, parseExportPresets, parseGodotDiagnostics } from './godot-project.mjs';
export const __test = {
  acceptanceTest,
  godotAutomationConfigSchema,
  godotExportTargetSchema,
  godotNativeInputSchema,
  godotScenarioSchema,
  godotStateAssertionSchema,
  mergeScenarioConfig,
  normalizeScene,
  parseGodotConfig,
  parseExportPresets,
  parseGodotDiagnostics,
  projectMetadata,
  runSavedScenario
};
