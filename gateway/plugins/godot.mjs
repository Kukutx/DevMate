import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { browserQaStatus, runBrowserScenario } from './browser-runner.mjs';
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

export const godotPlugin = definePlugin({
  manifest: {
    id: 'devmate.godot',
    name: 'Godot Development',
    version: '0.1.0',
    apiVersion: '1',
    description: 'Godot project inspection, headless validation, execution, Web export, local preview, and browser acceptance orchestration.',
    defaultEnabled: false,
    dependencies: ['devmate.browser-qa'],
    toolPrefixes: ['godot_'],
    capabilities: ['tools', 'workspace-read', 'workspace-write', 'processes', 'web-export', 'browser-qa'],
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
    return { executable, project };
  },
  activate(context) {
    const { server } = context;
    server.registerTool('godot_status', {
      title: 'Godot capability status',
      description: 'Inspect the active Godot project, export presets, project metadata, and configured executable without launching Godot.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, projectSubpath }) => {
      const inspection = await inspectProject(context, workspaceId, projectSubpath);
      let executable = null;
      let executableError = null;
      try { executable = resolveGodotExecutable(context); } catch (error) { executableError = error.message; }
      return context.toolText({ ...inspection, executable, executableError, settings: context.settings });
    });

    server.registerTool('godot_doctor', {
      title: 'Godot doctor',
      description: 'Run Godot --version and report project, renderer, Web preset, and Browser QA readiness.',
      inputSchema: { workspaceId: z.string().optional(), projectSubpath: z.string().optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, timeoutMs = 15000 }) => {
      const inspection = await inspectProject(context, workspaceId, projectSubpath);
      const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
      const executable = resolveGodotExecutable(context);
      const version = await context.executables.run(executable, ['--version'], { cwd: project.root, timeoutMs, maxOutputChars: 20000 });
      const browser = browserQaStatus(project.workspace.root, context.readConfig().plugins?.settings?.['devmate.browser-qa'] || {});
      const webPresets = inspection.project.presets.filter(item => /web/i.test(item.platform) || /web/i.test(item.name));
      return context.toolText({ inspection, executable, version, browserQa: browser, webPresets, ready: version.exitCode === 0 && webPresets.length > 0 });
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
      const exported = await exportWeb(context, { mode: 'debug', startLocalPreview: true, ...args });
      await context.audit('export_web', { workspace: exported.workspace.id, projectSubpath: exported.projectSubpath, preset: exported.preset, outputPath: exported.outputPath, ok: exported.ok, previewId: exported.preview?.id });
      return context.toolText(exported);
    });

    server.registerTool('godot_acceptance_test', {
      title: 'Run Godot Web acceptance test',
      description: 'Run Godot validation, export a Web build, start a local preview, execute bounded browser actions, capture a screenshot, and return a combined pass/fail report.',
      inputSchema: {
        workspaceId: z.string().optional(),
        projectSubpath: z.string().optional(),
        preset: z.string().optional(),
        outputPath: z.string().optional(),
        mode: z.enum(['debug', 'release']).optional(),
        actions: z.array(z.object({
          type: z.enum(['wait', 'press', 'key_down', 'key_up', 'click', 'move', 'type', 'focus', 'expect_visible', 'expect_text', 'screenshot']),
          ms: z.number().int().min(0).max(30000).optional(), key: z.string().optional(), selector: z.string().optional(), text: z.string().optional(),
          x: z.number().optional(), y: z.number().optional(), button: z.enum(['left', 'right', 'middle']).optional(), path: z.string().optional(),
          fullPage: z.boolean().optional(), timeoutMs: z.number().int().min(100).max(30000).optional()
        }).strict()).max(100).optional(),
        screenshotPath: z.string().optional(),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
        viewport: z.object({ width: z.number().int().min(320).max(3840).optional(), height: z.number().int().min(240).max(2160).optional() }).strict().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, preset, outputPath, mode = 'debug', actions = [], screenshotPath = 'artifacts/godot-qa/latest.png', timeoutMs, viewport = {} }) => {
      const validation = await validateProject(context, { workspaceId, projectSubpath, timeoutMs });
      if (!validation.ok) return context.toolText({ ok: false, stage: 'validation', validation, export: null, browser: null });
      const exported = await exportWeb(context, { workspaceId, projectSubpath, preset, outputPath, mode, timeoutMs, startLocalPreview: true, crossOriginIsolation: false });
      if (!exported.ok || !exported.preview) return context.toolText({ ok: false, stage: 'export', validation, export: exported, browser: null });
      const workspace = context.workspace.get(workspaceId, { writable: true });
      const browserSettings = context.readConfig().plugins?.settings?.['devmate.browser-qa'] || {};
      let browser;
      try {
        browser = await runBrowserScenario({ workspaceRoot: workspace.root, url: exported.preview.url, settings: browserSettings, actions, screenshotPath, timeoutMs: Math.min(120000, timeoutMs || 60000), viewport });
      } catch (error) {
        const report = { ok: false, stage: 'browser_setup', validation, export: exported, browser: null, error: error.message || String(error) };
        await context.audit('acceptance_test', { workspace: workspace.id, projectSubpath: validation.projectSubpath, ok: false, stage: 'browser_setup' });
        return context.toolText(report);
      }
      const visibleCanvas = browser.pageState?.canvases?.some(item => item.visible && item.clientWidth > 0 && item.clientHeight > 0);
      const ok = validation.ok && exported.ok && browser.ok && visibleCanvas;
      const report = { ok, stage: ok ? 'complete' : 'browser', validation, export: exported, browser, checks: { visibleCanvas: !!visibleCanvas, noPageErrors: browser.pageErrors.length === 0, noConsoleErrors: browser.consoleErrors.length === 0, noRequestFailures: browser.requestFailures.length === 0 } };
      await context.audit('acceptance_test', { workspace: workspace.id, projectSubpath: validation.projectSubpath, ok, screenshotPath: browser.screenshotPath });
      return context.toolText(report);
    });
  }
});


export { parseGodotConfig, parseExportPresets, parseGodotDiagnostics } from './godot-project.mjs';
export const __test = { normalizeScene, parseGodotConfig, parseExportPresets, parseGodotDiagnostics, projectMetadata };
