import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { browserActionSchema, browserViewportSchema } from './browser-schemas.mjs';
import { loadAutomationManifest, pluginAutomationConfig, scenarioById } from './automation-manifest.mjs';
import { inspectQaBridge, qaBridgeTemplate } from './godot-qa-bridge.mjs';
import {
  exportWeb, inspectProject, normalizeScene, parseGodotConfig, parseExportPresets,
  parseGodotDiagnostics, projectMetadata, resolveGodotExecutable, resolveProject, validateProject
} from './godot-project.mjs';

const settingsSchema = z.object({
  executablePath: z.string().max(2000).optional(),
  defaultProjectSubpath: z.string().max(1000).optional(),
  defaultWebPreset: z.string().max(200).optional(),
  defaultWebOutput: z.string().max(1000).optional(),
  validationTimeoutMs: z.number().int().min(1000).max(1800000).optional(),
  exportTimeoutMs: z.number().int().min(1000).max(1800000).optional()
}).strict();

export const godotScenarioSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  description: z.string().max(1000).optional(),
  projectSubpath: z.string().max(1000).optional(),
  preset: z.string().max(200).optional(),
  outputPath: z.string().max(1000).optional(),
  mode: z.enum(['debug', 'release']).optional(),
  actions: z.array(browserActionSchema).max(100).optional(),
  screenshotPath: z.string().max(1000).optional(),
  reportPath: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(1800000).optional(),
  viewport: browserViewportSchema.optional(),
  crossOriginIsolation: z.boolean().optional()
}).strict();

const godotAutomationConfigSchema = z.object({
  projectSubpath: z.string().max(1000).default('.'),
  preset: z.string().max(200).default('Web'),
  outputPath: z.string().max(1000).default('build/web/index.html'),
  mode: z.enum(['debug', 'release']).default('debug'),
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
  return {
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

export const godotPlugin = definePlugin({
  manifest: {
    id: 'devmate.godot',
    name: 'Godot Development',
    version: '0.2.0',
    apiVersion: '1',
    description: 'Godot project inspection, headless validation, execution, Web export, local preview, and browser acceptance orchestration.',
    defaultEnabled: false,
    dependencies: ['devmate.browser-qa'],
    consumes: ['devmate.browser-qa'],
    toolPrefixes: ['godot_'],
    capabilities: ['tools', 'workspace-read', 'workspace-write', 'processes', 'web-export', 'browser-qa', 'automation-manifest', 'structured-state'],
    permissions: { executablePatterns: ['^godot(?:4)?(?:[._-].*)?(?:\\.exe)?$'] }
  },
  settingsSchema,
  defaultSettings: {
    executablePath: '',
    defaultProjectSubpath: '.',
    defaultWebPreset: 'Web',
    defaultWebOutput: 'build/web/index.html',
    validationTimeoutMs: 300000,
    exportTimeoutMs: 600000
  },
  async diagnose(context) {
    let executable = null;
    try { executable = resolveGodotExecutable(context); } catch {}
    let project = null;
    try { project = await inspectProject(context); } catch (error) { project = { error: error.message }; }
    let browser = null;
    try {
      const workspace = context.workspace.get(undefined, { writable: false });
      browser = browserService(context).status(workspace.root);
    } catch (error) { browser = { error: error.message }; }
    return { executable, project, browser };
  },
  activate(context) {
    const { server } = context;

    server.registerTool('godot_status', {
      title: 'Godot capability status',
      description: 'Inspect the active Godot project, export presets, QA bridge, project metadata, and configured executable without launching Godot.',
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

    server.registerTool('godot_doctor', {
      title: 'Godot doctor',
      description: 'Run Godot --version and report project, renderer, Web preset, QA bridge, and Browser QA readiness.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, timeoutMs = 15000 }) => {
      const inspection = await inspectProject(context, workspaceId, projectSubpath);
      const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
      const executable = resolveGodotExecutable(context);
      const version = await context.executables.run(executable, ['--version'], { cwd: project.root, timeoutMs, maxOutputChars: 20000 });
      const browser = browserService(context).status(project.workspace.root);
      const qaBridge = await inspectQaBridge(project.root);
      const webPresets = inspection.project.presets.filter(item => /web/i.test(item.platform) || /web/i.test(item.name));
      return context.toolText({ inspection, executable, version, browserQa: browser, qaBridge, webPresets, ready: version.exitCode === 0 && webPresets.length > 0 && browser.available });
    });

    server.registerTool('godot_qa_bridge_status', {
      title: 'Godot QA bridge status',
      description: 'Check whether the optional DevMateQA autoload bridge is installed and configured in the selected Godot project.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, projectSubpath }) => {
      const project = resolveProject(context, workspaceId, projectSubpath);
      return context.toolText({ workspace: { id: project.workspace.id, name: project.workspace.name }, projectSubpath: project.subpath, qaBridge: await inspectQaBridge(project.root) });
    });

    server.registerTool('godot_qa_bridge_template', {
      title: 'Godot QA bridge template',
      description: 'Return the reviewed DevMateQA GDScript autoload template and project.godot entry so ChatGPT can install it through normal DevMate file tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async () => context.toolText(qaBridgeTemplate()));

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
      description: 'Start a persistent Godot game or editor process that can be inspected and stopped through DevMate process tools.',
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
        label: editor ? 'Godot editor' : 'Godot game',
        autoStopAfterMs
      });
      await context.audit('run', { workspace: project.workspace.id, projectSubpath: project.subpath, processId: processRecord.id, editor, headless });
      return context.toolText({ process: processRecord, executable, args });
    });

    server.registerTool('godot_export_web', {
      title: 'Export Godot Web build',
      description: 'Validate export inputs, run a Godot Web export, and optionally start a local HTTP preview URL.',
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

    server.registerTool('godot_automation_manifest', {
      title: 'Godot saved acceptance scenarios',
      description: 'Read and validate version-controlled Godot acceptance scenarios from .devmate/automation.json.',
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
      description: 'Run one version-controlled Godot acceptance scenario from .devmate/automation.json.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().optional(), scenarioId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, manifestPath, scenarioId }) => {
      const loaded = await loadGodotAutomation(context, { workspaceId, manifestPath });
      const scenario = godotScenarioSchema.parse(scenarioById(loaded.config.scenarios, scenarioId));
      const report = await acceptanceTest(context, { workspaceId, ...mergeScenarioConfig(loaded.config, scenario) });
      await context.audit('acceptance_run_saved', { workspace: report.validation?.workspace?.id, scenarioId, ok: report.ok, stage: report.stage });
      return context.toolText({ manifestPath: loaded.manifestPath, scenario, report });
    });

    server.registerTool('godot_acceptance_suite', {
      title: 'Run saved Godot acceptance suite',
      description: 'Run selected or all version-controlled Godot acceptance scenarios and return an aggregate report.',
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
        const report = await acceptanceTest(context, { workspaceId, ...mergeScenarioConfig(loaded.config, scenario) });
        results.push({ id: scenario.id, description: scenario.description || '', report });
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
export const __test = { acceptanceTest, godotAutomationConfigSchema, godotScenarioSchema, mergeScenarioConfig, normalizeScene, parseGodotConfig, parseExportPresets, parseGodotDiagnostics, projectMetadata };
