import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import {
  actBrowserControl,
  browserControlSessions,
  browserControlStatus,
  listBrowserTabs,
  snapshotBrowserControl,
  startBrowserControl,
  stopBrowserControl
} from './browser-control-runtime.mjs';

const settingsSchema = z.object({
  playwrightModulePath: z.string().max(2000).optional(),
  chromiumExecutablePath: z.string().max(2000).optional(),
  allowRemoteUrls: z.boolean().optional(),
  defaultHeadless: z.boolean().optional()
}).strict();

const viewportSchema = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional()
}).strict();

export const browserControlActionSchema = z.object({
  type: z.enum([
    'navigate', 'back', 'forward', 'reload', 'wait', 'wait_for',
    'click', 'type', 'press', 'focus', 'hover', 'scroll', 'select', 'check', 'uncheck',
    'open_tab', 'switch_tab', 'close_tab', 'screenshot'
  ]),
  url: z.string().url().max(4000).optional(),
  ref: z.string().max(100).optional(),
  snapshotId: z.string().max(200).optional(),
  selector: z.string().max(2000).optional(),
  role: z.string().max(100).optional(),
  name: z.string().max(1000).optional(),
  targetText: z.string().max(2000).optional(),
  exact: z.boolean().optional(),
  text: z.string().max(20000).optional(),
  key: z.string().max(100).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  x: z.number().min(-10000).max(10000).optional(),
  y: z.number().min(-10000).max(10000).optional(),
  deltaX: z.number().min(-100000).max(100000).optional(),
  deltaY: z.number().min(-100000).max(100000).optional(),
  value: z.string().max(2000).optional(),
  values: z.array(z.string().max(2000)).max(50).optional(),
  ms: z.number().int().min(0).max(30000).optional(),
  state: z.enum(['attached', 'detached', 'visible', 'hidden']).optional(),
  targetTabId: z.string().max(200).optional(),
  path: z.string().max(1000).optional(),
  fullPage: z.boolean().optional(),
  timeoutMs: z.number().int().min(100).max(30000).optional()
}).strict();

function serviceWorkspace(context, workspaceId, { writable = false } = {}) {
  return context.workspace.get(workspaceId, { writable });
}

export const browserControlPlugin = definePlugin({
  manifest: {
    id: 'devmate.browser-control',
    name: 'Browser Control',
    version: '0.1.0',
    apiVersion: '1',
    description: 'Long-lived Playwright browser sessions for interactive navigation, multi-tab control, semantic snapshots, and bounded user-visible automation.',
    defaultEnabled: false,
    toolPrefixes: ['browser_control_'],
    capabilities: ['tools', 'browser-automation', 'interactive-browser', 'multi-tab', 'screenshots'],
    provides: [],
    consumes: [],
    permissions: { executablePatterns: [] }
  },
  settingsSchema,
  defaultSettings: {
    playwrightModulePath: '',
    chromiumExecutablePath: '',
    allowRemoteUrls: false,
    defaultHeadless: false
  },
  async diagnose(context) {
    const workspace = serviceWorkspace(context, undefined, { writable: false });
    return browserControlStatus(workspace.root, context.settings);
  },
  activate(context) {
    const { server } = context;

    server.registerTool('browser_control_status', {
      title: 'Browser control status',
      description: 'Check the interactive Browser Control runtime and list managed sessions for the selected workspace.',
      inputSchema: { workspaceId: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId }) => {
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      return context.toolText({
        workspace: { id: workspace.id, name: workspace.name },
        status: browserControlStatus(workspace.root, context.settings),
        sessions: await browserControlSessions(workspace.id)
      });
    });

    server.registerTool('browser_control_start', {
      title: 'Start managed browser session',
      description: 'Start a long-lived Playwright browser session for the selected workspace. Remote URLs remain blocked unless allowRemoteUrls is explicitly enabled for this plugin.',
      inputSchema: {
        workspaceId: z.string().optional(),
        url: z.string().url().max(4000).optional(),
        headless: z.boolean().optional(),
        viewport: viewportSchema.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, url = '', headless, viewport = {} }) => {
      context.assertCanMutate('Starting an interactive browser session');
      const workspace = serviceWorkspace(context, workspaceId, { writable: true });
      const result = await startBrowserControl({ workspaceId: workspace.id, workspaceRoot: workspace.root, settings: context.settings, url, headless, viewport });
      await context.audit('session_start', {
        workspace: workspace.id,
        sessionId: result.session.id,
        headless: result.session.headless,
        allowRemoteUrls: result.session.allowRemoteUrls,
        initialUrl: url || null
      });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });

    server.registerTool('browser_control_tabs', {
      title: 'List browser tabs',
      description: 'List tabs in one managed browser session, including the active tab, current URLs, and titles.',
      inputSchema: { workspaceId: z.string().optional(), sessionId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, sessionId }) => {
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, session: await listBrowserTabs({ workspaceId: workspace.id, sessionId }) });
    });

    server.registerTool('browser_control_snapshot', {
      title: 'Snapshot browser tab',
      description: 'Read one browser tab as bounded text, semantic/ARIA content, interactive element refs, frames, and recent browser diagnostics. Element refs are valid only for the returned snapshotId.',
      inputSchema: {
        workspaceId: z.string().optional(),
        sessionId: z.string().min(1).max(200),
        tabId: z.string().max(200).optional(),
        maxElements: z.number().int().min(1).max(250).optional(),
        bodyChars: z.number().int().min(1000).max(30000).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async args => {
      const workspace = serviceWorkspace(context, args.workspaceId, { writable: false });
      const snapshot = await snapshotBrowserControl({ ...args, workspaceId: workspace.id });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, snapshot });
    });

    server.registerTool('browser_control_act', {
      title: 'Act in managed browser',
      description: 'Perform one bounded browser action such as navigation, click, typing, keyboard input, scrolling, selection, tab control, waits, or a workspace-contained screenshot. Use snapshotId with element refs to reject stale targets.',
      inputSchema: {
        workspaceId: z.string().optional(),
        sessionId: z.string().min(1).max(200),
        tabId: z.string().max(200).optional(),
        action: browserControlActionSchema
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, sessionId, tabId = '', action }) => {
      context.assertCanMutate('Controlling an interactive browser session');
      const workspace = serviceWorkspace(context, workspaceId, { writable: true });
      const result = await actBrowserControl({ workspaceId: workspace.id, sessionId, tabId, action });
      await context.audit('act', {
        workspace: workspace.id,
        sessionId,
        tabId: result.tab?.id || tabId || null,
        actionType: action.type,
        currentUrl: result.tab?.url || null
      });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });

    server.registerTool('browser_control_stop', {
      title: 'Stop managed browser session',
      description: 'Close one managed Browser Control session and all of its tabs.',
      inputSchema: { workspaceId: z.string().optional(), sessionId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ workspaceId, sessionId }) => {
      context.assertCanMutate('Stopping an interactive browser session');
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      const result = await stopBrowserControl({ workspaceId: workspace.id, sessionId });
      await context.audit('session_stop', { workspace: workspace.id, sessionId });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });
  }
});

export const __test = { browserControlActionSchema, settingsSchema, viewportSchema };
