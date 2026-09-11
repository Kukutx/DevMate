import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import {
  actBrowserControl,
  browserControlSessions,
  browserControlStatus,
  listBrowserTabs,
  resumeBrowserControl,
  snapshotBrowserControl,
  startBrowserControl,
  stopBrowserControl,
  takeoverBrowserControl
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
    'click', 'double_click', 'type', 'press', 'focus', 'hover', 'scroll', 'select', 'check', 'uncheck',
    'drag', 'upload', 'download', 'open_tab', 'switch_tab', 'close_tab', 'screenshot'
  ]),
  url: z.string().url().max(4000).optional(),
  ref: z.string().max(100).optional(),
  snapshotId: z.string().max(200).optional(),
  selector: z.string().max(2000).optional(),
  role: z.string().max(100).optional(),
  name: z.string().max(1000).optional(),
  targetText: z.string().max(2000).optional(),
  exact: z.boolean().optional(),
  destinationRef: z.string().max(100).optional(),
  destinationSnapshotId: z.string().max(200).optional(),
  destinationSelector: z.string().max(2000).optional(),
  destinationRole: z.string().max(100).optional(),
  destinationName: z.string().max(1000).optional(),
  destinationText: z.string().max(2000).optional(),
  destinationExact: z.boolean().optional(),
  text: z.string().max(20000).optional(),
  key: z.string().max(100).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  x: z.number().min(-10000).max(10000).optional(),
  y: z.number().min(-10000).max(10000).optional(),
  destinationX: z.number().min(-10000).max(10000).optional(),
  destinationY: z.number().min(-10000).max(10000).optional(),
  deltaX: z.number().min(-100000).max(100000).optional(),
  deltaY: z.number().min(-100000).max(100000).optional(),
  value: z.string().max(2000).optional(),
  values: z.array(z.string().max(2000)).max(50).optional(),
  paths: z.array(z.string().min(1).max(1000)).max(20).optional(),
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

function runtimeAction(action) {
  if (!action || action.type !== 'drag') return action;
  return {
    ...action,
    targetRef: action.destinationRef,
    targetSnapshotId: action.destinationSnapshotId,
    targetSelector: action.destinationSelector,
    targetRole: action.destinationRole,
    targetName: action.destinationName,
    targetTargetText: action.destinationText,
    targetExact: action.destinationExact,
    targetX: action.destinationX,
    targetY: action.destinationY
  };
}

function snapshotToolResponse(context, workspace, snapshot) {
  const screenshot = snapshot.screenshot || null;
  const publicScreenshot = screenshot ? Object.fromEntries(Object.entries(screenshot).filter(([key]) => key !== 'data')) : null;
  const publicSnapshot = { ...snapshot, screenshot: publicScreenshot };
  const payload = { workspace: { id: workspace.id, name: workspace.name }, snapshot: publicSnapshot };
  if (!screenshot?.data) return context.toolText(payload);
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
      { type: 'image', data: screenshot.data, mimeType: screenshot.mimeType }
    ],
    structuredContent: payload
  };
}

export const browserControlPlugin = definePlugin({
  manifest: {
    id: 'devmate.browser-control',
    name: 'Browser Control',
    version: '0.2.0',
    apiVersion: '1',
    description: 'Long-lived Playwright browser sessions with semantic and visual snapshots, file transfer, persistent workspace profiles, human takeover, and bounded user-visible automation.',
    defaultEnabled: false,
    toolPrefixes: ['browser_control_'],
    capabilities: [
      'tools', 'browser-automation', 'interactive-browser', 'multi-tab', 'screenshots', 'visual-snapshots',
      'file-transfer', 'persistent-browser-profile', 'human-takeover'
    ],
    provides: [],
    consumes: [],
    permissions: {
      executablePatterns: [],
      secretSettingKeys: ['playwrightModulePath', 'chromiumExecutablePath']
    }
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
    const status = browserControlStatus(workspace.root, context.settings);
    return {
      available: status.available,
      moduleConfigured: status.moduleConfigured,
      chromiumExecutableConfigured: !!status.chromiumExecutablePath,
      chromiumExecutableExists: status.chromiumExecutableExists,
      chromiumExecutableAllowed: status.chromiumExecutableAllowed,
      allowRemoteUrls: status.allowRemoteUrls,
      defaultHeadless: status.defaultHeadless,
      persistentProfilesAvailable: status.persistentProfilesAvailable,
      activePersistentProfiles: status.activePersistentProfiles,
      maxSessions: status.maxSessions,
      activeSessions: status.activeSessions,
      error: status.error
    };
  },
  activate(context) {
    const { server } = context;

    server.registerTool('browser_control_status', {
      title: 'Browser control status',
      description: 'Check the interactive Browser Control runtime and list managed sessions for the selected workspace, including profile and human-takeover state.',
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
      description: 'Start a long-lived Playwright browser session for the selected workspace. profileMode=workspace keeps an isolated DevMate-private browser profile across restarts; ephemeral remains the default. Remote URLs remain opt-in.',
      inputSchema: {
        workspaceId: z.string().optional(),
        url: z.string().url().max(4000).optional(),
        headless: z.boolean().optional(),
        profileMode: z.enum(['ephemeral', 'workspace']).optional(),
        viewport: viewportSchema.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, url = '', headless, profileMode = 'ephemeral', viewport = {} }) => {
      context.assertCanMutate('Starting an interactive browser session');
      const workspace = serviceWorkspace(context, workspaceId, { writable: true });
      const result = await startBrowserControl({ workspaceId: workspace.id, workspaceRoot: workspace.root, settings: context.settings, url, headless, profileMode, viewport });
      await context.audit('session_start', {
        workspace: workspace.id,
        sessionId: result.session.id,
        headless: result.session.headless,
        profileMode: result.session.profileMode,
        allowRemoteUrls: result.session.allowRemoteUrls,
        hasInitialUrl: !!url
      });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, session: result.session });
    });

    server.registerTool('browser_control_tabs', {
      title: 'List browser tabs',
      description: 'List tabs in one managed browser session, including the active tab, profile mode, control mode, URLs, and titles.',
      inputSchema: { workspaceId: z.string().optional(), sessionId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, sessionId }) => {
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, session: await listBrowserTabs({ workspaceId: workspace.id, sessionId }) });
    });

    server.registerTool('browser_control_snapshot', {
      title: 'Snapshot browser tab',
      description: 'Read one browser tab as bounded text, ARIA content, interactive element refs, geometry, frames, diagnostics, and an optional inline screenshot for visual reasoning. Element refs are valid only for the returned snapshotId.',
      inputSchema: {
        workspaceId: z.string().optional(),
        sessionId: z.string().min(1).max(200),
        tabId: z.string().max(200).optional(),
        maxElements: z.number().int().min(1).max(250).optional(),
        bodyChars: z.number().int().min(1000).max(30000).optional(),
        includeScreenshot: z.boolean().optional(),
        screenshotFormat: z.enum(['png', 'jpeg']).optional(),
        screenshotQuality: z.number().int().min(30).max(95).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async args => {
      const workspace = serviceWorkspace(context, args.workspaceId, { writable: false });
      const snapshot = await snapshotBrowserControl({ ...args, workspaceId: workspace.id });
      return snapshotToolResponse(context, workspace, snapshot);
    });

    server.registerTool('browser_control_act', {
      title: 'Act in managed browser',
      description: 'Perform one bounded browser action: navigation, click/double-click, typing, keyboard, scrolling, selection, drag/drop, workspace-safe upload/download capture, tab control, waits, or a workspace-contained screenshot. Snapshot refs reject stale targets.',
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
      const result = await actBrowserControl({ workspaceId: workspace.id, sessionId, tabId, action: runtimeAction(action) });
      await context.audit('act', {
        workspace: workspace.id,
        sessionId,
        tabId: result.tab?.id || tabId || null,
        actionType: action.type
      });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });

    server.registerTool('browser_control_takeover', {
      title: 'Pause browser automation for human takeover',
      description: 'Pause model-driven actions for one visible managed browser session so the user can interact manually. Existing element refs are invalidated.',
      inputSchema: { workspaceId: z.string().optional(), sessionId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, sessionId }) => {
      context.assertCanMutate('Pausing browser automation for human takeover');
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      const result = await takeoverBrowserControl({ workspaceId: workspace.id, sessionId });
      await context.audit('takeover', { workspace: workspace.id, sessionId });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });

    server.registerTool('browser_control_resume', {
      title: 'Resume browser automation after human takeover',
      description: 'Return one managed browser session to model-driven control after human interaction. Existing element refs remain invalid and a fresh snapshot is required.',
      inputSchema: { workspaceId: z.string().optional(), sessionId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, sessionId }) => {
      context.assertCanMutate('Resuming browser automation after human takeover');
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      const result = await resumeBrowserControl({ workspaceId: workspace.id, sessionId });
      await context.audit('resume', { workspace: workspace.id, sessionId });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });

    server.registerTool('browser_control_stop', {
      title: 'Stop managed browser session',
      description: 'Close one managed Browser Control session and all of its tabs. Persistent workspace profile data remains in DevMate private state for later sessions.',
      inputSchema: { workspaceId: z.string().optional(), sessionId: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ workspaceId, sessionId }) => {
      context.assertCanMutate('Stopping an interactive browser session');
      const workspace = serviceWorkspace(context, workspaceId, { writable: false });
      const result = await stopBrowserControl({ workspaceId: workspace.id, sessionId });
      await context.audit('session_stop', { workspace: workspace.id, sessionId, profileMode: result.profileMode });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, ...result });
    });
  }
});

export const __test = { browserControlActionSchema, runtimeAction, settingsSchema, snapshotToolResponse, viewportSchema };
