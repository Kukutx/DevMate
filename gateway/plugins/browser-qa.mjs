import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { browserQaStatus, runBrowserScenario } from './browser-runner.mjs';
import { getPreview, listPreviews, startPreview, stopPreview, stopWorkspacePreviews } from './preview-manager.mjs';
import { loadAutomationManifest, pluginAutomationConfig, scenarioById } from './automation-manifest.mjs';
import { sensitiveWorkspacePathReason } from '../sensitive-path-policy.mjs';

import { browserActionSchema, browserScenarioSchema, browserViewportSchema } from './browser-schemas.mjs';

const automationConfigSchema = z.object({
  scenarios: z.array(browserScenarioSchema).max(100).default([])
}).strict();

const settingsSchema = z.object({
  playwrightModulePath: z.string().max(2000).optional(),
  chromiumExecutablePath: z.string().max(2000).optional(),
  allowRemoteUrls: z.boolean().optional()
}).strict();

function serviceWorkspaceFromRoot(context, workspaceRoot, { writable = false } = {}) {
  const requested = fs.realpathSync.native(String(workspaceRoot || ''));
  const config = context.readConfig();
  const matches = (Array.isArray(config?.workspaces) ? config.workspaces : []).filter(workspace => {
    try { return fs.realpathSync.native(workspace.root) === requested; }
    catch { return false; }
  });
  if (matches.length !== 1) {
    const error = new Error('Browser QA service workspace root is not a uniquely configured DevMate workspace');
    error.code = 'browser_qa_workspace_boundary';
    throw error;
  }
  return context.workspace.get(matches[0].id, { writable });
}

function resolvePreviewRoot(context, workspace, rootInput) {
  const root = context.workspace.resolve(workspace, rootInput, { mustExist: true, directory: true });
  const relative = path.relative(fs.realpathSync.native(workspace.root), root).replace(/\\/g, '/');
  const reason = sensitiveWorkspacePathReason(relative);
  if (reason) {
    const error = new Error(`Preview root targets protected workspace data (${reason}): ${relative}`);
    error.code = 'preview_protected_root';
    throw error;
  }
  return root;
}

async function savedScenario(context, { workspaceId, manifestPath, scenarioId }) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath });
  const config = automationConfigSchema.parse(pluginAutomationConfig(loaded.manifest, 'devmate.browser-qa'));
  const scenario = browserScenarioSchema.parse(scenarioById(config.scenarios, scenarioId));
  const workspace = context.workspace.get(workspaceId, { writable: true });
  let preview = null;
  if (scenario.preview) {
    const root = resolvePreviewRoot(context, workspace, scenario.preview.rootSubpath);
    preview = await startPreview({
      workspaceId: workspace.id,
      root,
      entryPath: scenario.preview.entryPath,
      port: scenario.preview.port || 0,
      crossOriginIsolation: !!scenario.preview.crossOriginIsolation,
      spaFallback: !!scenario.preview.spaFallback
    });
  }
  const result = await runBrowserScenario({
    workspaceRoot: workspace.root,
    url: scenario.url || preview.url,
    settings: context.settings,
    actions: scenario.actions || [],
    screenshotPath: scenario.screenshotPath || `artifacts/browser-qa/${scenario.id}.png`,
    reportPath: scenario.reportPath || `artifacts/browser-qa/${scenario.id}.json`,
    timeoutMs: scenario.timeoutMs || 60000,
    viewport: scenario.viewport || {}
  });
  return { workspace: { id: workspace.id, name: workspace.name }, manifestPath: loaded.manifestPath, scenario, preview, result };
}

export const browserQaPlugin = definePlugin({
  manifest: {
    id: 'devmate.browser-qa',
    name: 'Browser QA',
    version: '0.2.0',
    apiVersion: '1',
    description: 'Local static previews and Playwright-based browser acceptance testing for web applications and game exports.',
    defaultEnabled: false,
    toolPrefixes: ['browser_', 'web_preview_'],
    capabilities: ['tools', 'local-http', 'browser-automation', 'screenshots', 'automation-manifest', 'structured-state'],
    provides: ['devmate.browser-qa'],
    permissions: { executablePatterns: [] }
  },
  settingsSchema,
  defaultSettings: {
    playwrightModulePath: '',
    chromiumExecutablePath: '',
    allowRemoteUrls: false
  },
  async diagnose(context) {
    const workspace = context.workspace.get(undefined, { writable: false });
    return browserQaStatus(workspace.root, context.settings);
  },
  activate(context) {
    const { server } = context;
    const service = Object.freeze({
      status: workspaceRoot => {
        const workspace = serviceWorkspaceFromRoot(context, workspaceRoot, { writable: false });
        return browserQaStatus(workspace.root, context.settings);
      },
      runScenario: ({ workspaceRoot, ...args }) => {
        const workspace = serviceWorkspaceFromRoot(context, workspaceRoot, { writable: true });
        return runBrowserScenario({
          ...args,
          workspaceRoot: workspace.root,
          settings: { ...context.settings, ...(args.settings || {}) }
        });
      },
      startPreview: ({ workspaceId, root, ...args }) => {
        const workspace = context.workspace.get(workspaceId, { writable: false });
        const resolvedRoot = resolvePreviewRoot(context, workspace, root);
        return startPreview({ ...args, workspaceId: workspace.id, root: resolvedRoot });
      },
      getPreview,
      listPreviews,
      stopPreview,
      stopWorkspacePreviews
    });
    context.services.provide('devmate.browser-qa', service);

    server.registerTool('web_preview_start', {
      title: 'Start local web preview',
      description: 'Use this when a built web app or Godot Web export should be served from a safe local HTTP URL for user preview or browser QA.',
      inputSchema: {
        workspaceId: z.string().optional(),
        rootSubpath: z.string().default('build/web'),
        entryPath: z.string().default('index.html'),
        port: z.number().int().min(0).max(65535).optional(),
        crossOriginIsolation: z.boolean().optional(),
        spaFallback: z.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, rootSubpath = 'build/web', entryPath = 'index.html', port = 0, crossOriginIsolation = false, spaFallback = false }) => {
      context.assertCanMutate('Starting a local preview');
      const workspace = context.workspace.get(workspaceId, { writable: true });
      const root = resolvePreviewRoot(context, workspace, rootSubpath);
      const preview = await startPreview({ workspaceId: workspace.id, root, entryPath, port, crossOriginIsolation, spaFallback });
      await context.audit('preview_start', { workspace: workspace.id, rootSubpath, entryPath, previewId: preview.id, port: preview.port });
      return context.toolText({ preview });
    });

    server.registerTool('web_preview_status', {
      title: 'Local web preview status',
      description: 'List running DevMate local web previews or inspect one preview by id.',
      inputSchema: { workspaceId: z.string().optional(), id: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, id }) => context.toolText(id ? { preview: getPreview(id) } : { previews: listPreviews({ workspaceId }) }));

    server.registerTool('web_preview_stop', {
      title: 'Stop local web preview',
      description: 'Stop one local preview or all previews belonging to a workspace.',
      inputSchema: { workspaceId: z.string().optional(), id: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, id }) => {
      context.assertCanMutate('Stopping a local preview');
      if (id) return context.toolText(await stopPreview(id));
      const workspace = context.workspace.get(workspaceId, { writable: false });
      return context.toolText({ stopped: await stopWorkspacePreviews(workspace.id) });
    });

    server.registerTool('browser_qa_status', {
      title: 'Browser QA status',
      description: 'Check whether Playwright and an available Chromium runtime can be resolved for the active workspace.',
      inputSchema: { workspaceId: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId }) => {
      const workspace = context.workspace.get(workspaceId, { writable: false });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, status: browserQaStatus(workspace.root, context.settings) });
    });

    server.registerTool('browser_qa_manifest', {
      title: 'Browser QA saved scenarios',
      description: 'Read and validate version-controlled Browser QA scenarios from .devmate/automation.json.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, manifestPath }) => {
      const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required: false });
      if (!loaded.exists) return context.toolText({ ...loaded, scenarios: [] });
      const config = automationConfigSchema.parse(pluginAutomationConfig(loaded.manifest, 'devmate.browser-qa'));
      return context.toolText({ ...loaded, manifest: undefined, scenarios: config.scenarios });
    });

    server.registerTool('browser_qa_run_saved', {
      title: 'Run saved browser scenario',
      description: 'Run one version-controlled Browser QA scenario from .devmate/automation.json.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().optional(), scenarioId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async args => {
      context.assertCanMutate('Running saved browser acceptance tests');
      const report = await savedScenario(context, args);
      await context.audit('browser_qa_run_saved', { workspace: report.workspace.id, scenarioId: report.scenario.id, ok: report.result.ok, screenshotPath: report.result.screenshotPath, reportPath: report.result.reportPath });
      return context.toolText(report);
    });

    server.registerTool('browser_qa_run', {
      title: 'Run browser acceptance scenario',
      description: 'Use this to open a local preview, perform bounded keyboard/mouse/DOM/state actions, capture screenshots, and report console, page, network, and assertion failures.',
      inputSchema: {
        workspaceId: z.string().optional(),
        url: z.string().url(),
        actions: z.array(browserActionSchema).max(100).optional(),
        screenshotPath: z.string().max(1000).optional(),
        reportPath: z.string().max(1000).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        viewport: browserViewportSchema.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, url, actions = [], screenshotPath = 'artifacts/browser-qa/latest.png', reportPath = 'artifacts/browser-qa/latest.json', timeoutMs = 60000, viewport = {} }) => {
      context.assertCanMutate('Running browser acceptance tests');
      const workspace = context.workspace.get(workspaceId, { writable: true });
      const result = await runBrowserScenario({ workspaceRoot: workspace.root, url, settings: context.settings, actions, screenshotPath, reportPath, timeoutMs, viewport });
      await context.audit('browser_qa_run', { workspace: workspace.id, url, actionCount: actions.length, ok: result.ok, screenshotPath: result.screenshotPath, reportPath: result.reportPath });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, result });
    });
  }
});

export const __test = { automationConfigSchema, browserActionSchema, browserScenarioSchema, resolvePreviewRoot, serviceWorkspaceFromRoot, settingsSchema };
