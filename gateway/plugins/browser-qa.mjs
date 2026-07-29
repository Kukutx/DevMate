import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { browserQaStatus, runBrowserScenario } from './browser-runner.mjs';
import { getPreview, listPreviews, startPreview, stopPreview, stopWorkspacePreviews } from './preview-manager.mjs';

const actionSchema = z.object({
  type: z.enum(['wait', 'press', 'key_down', 'key_up', 'click', 'move', 'type', 'focus', 'expect_visible', 'expect_text', 'screenshot']),
  ms: z.number().int().min(0).max(30000).optional(),
  key: z.string().max(100).optional(),
  selector: z.string().max(2000).optional(),
  text: z.string().max(20000).optional(),
  x: z.number().min(-10000).max(10000).optional(),
  y: z.number().min(-10000).max(10000).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  path: z.string().max(1000).optional(),
  fullPage: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30000).optional()
}).strict();

const settingsSchema = z.object({
  playwrightModulePath: z.string().max(2000).optional(),
  chromiumExecutablePath: z.string().max(2000).optional(),
  allowRemoteUrls: z.boolean().optional()
}).strict();

export const browserQaPlugin = definePlugin({
  manifest: {
    id: 'devmate.browser-qa',
    name: 'Browser QA',
    version: '0.1.0',
    apiVersion: '1',
    description: 'Local static previews and Playwright-based browser acceptance testing for web applications and game exports.',
    defaultEnabled: false,
    toolPrefixes: ['browser_', 'web_preview_'],
    capabilities: ['tools', 'local-http', 'browser-automation', 'screenshots'],
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
      const root = context.workspace.resolve(workspace, rootSubpath, { mustExist: true, directory: true });
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

    server.registerTool('browser_qa_run', {
      title: 'Run browser acceptance scenario',
      description: 'Use this to open a local preview, perform bounded keyboard/mouse/DOM actions, capture screenshots, and report console, page, and network failures.',
      inputSchema: {
        workspaceId: z.string().optional(),
        url: z.string().url(),
        actions: z.array(actionSchema).max(100).optional(),
        screenshotPath: z.string().max(1000).optional(),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        viewport: z.object({ width: z.number().int().min(320).max(3840).optional(), height: z.number().int().min(240).max(2160).optional() }).strict().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, url, actions = [], screenshotPath = 'artifacts/browser-qa/latest.png', timeoutMs = 60000, viewport = {} }) => {
      context.assertCanMutate('Running browser acceptance tests');
      const workspace = context.workspace.get(workspaceId, { writable: true });
      const result = await runBrowserScenario({ workspaceRoot: workspace.root, url, settings: context.settings, actions, screenshotPath, timeoutMs, viewport });
      await context.audit('browser_qa_run', { workspace: workspace.id, url, actionCount: actions.length, ok: result.ok, screenshotPath: result.screenshotPath });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, result });
    });
  }
});

export const __test = { actionSchema, settingsSchema };
