import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_TABS_PER_SESSION,
  assertBrowserAgentControl,
  browserActionTimeout,
  browserNavigate,
  browserSessionSummary,
  browserTabSummary,
  getBrowserPage,
  getBrowserSession,
  invalidateBrowserSnapshot,
  registerBrowserPage,
  resolveBrowserLocator,
  resolveBrowserTargetLocator,
  safeBrowserWorkspaceInput,
  safeBrowserWorkspaceOutput
} from './browser-control-core.mjs';

async function locatorPoint(locator, label) {
  if (!locator || typeof locator.boundingBox !== 'function') throw new Error(`${label} does not expose a bounding box`);
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${label} is not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function dragWithMouse(page, source, target) {
  await page.mouse.move(source.x, source.y);
  await page.mouse.down();
  try {
    await page.mouse.move(target.x, target.y, { steps: 8 });
  } finally {
    await page.mouse.up();
  }
}

async function performAction(session, metadata, action) {
  const page = metadata.page;
  const type = String(action.type || '').trim();
  const timeout = browserActionTimeout(action);
  if (type === 'navigate') return { type, ...(await browserNavigate(page, action.url, session.allowRemoteUrls, timeout)) };
  if (type === 'back') { const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout }); return { type, url: page.url(), status: response?.status?.() ?? null }; }
  if (type === 'forward') { const response = await page.goForward({ waitUntil: 'domcontentloaded', timeout }); return { type, url: page.url(), status: response?.status?.() ?? null }; }
  if (type === 'reload') { const response = await page.reload({ waitUntil: 'domcontentloaded', timeout }); return { type, url: page.url(), status: response?.status?.() ?? null }; }
  if (type === 'wait') { const ms = Math.min(30000, Math.max(0, Number(action.ms) || 0)); await page.waitForTimeout(ms); return { type, ms }; }
  if (type === 'wait_for') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error('wait_for requires ref, selector, role, or targetText');
    await locator.waitFor({ state: action.state || 'visible', timeout });
    return { type, state: action.state || 'visible' };
  }
  if (type === 'click' || type === 'double_click') {
    const locator = resolveBrowserLocator(metadata, action);
    if (locator) {
      if (type === 'double_click') await locator.dblclick({ button: action.button || 'left', timeout });
      else await locator.click({ button: action.button || 'left', timeout });
      return { type, target: action.ref || action.selector || action.role || action.targetText };
    }
    if (action.x == null || action.y == null) throw new Error(`${type} requires a target or x/y coordinates`);
    if (type === 'double_click') await page.mouse.dblclick(Number(action.x), Number(action.y), { button: action.button || 'left' });
    else await page.mouse.click(Number(action.x), Number(action.y), { button: action.button || 'left' });
    return { type, x: Number(action.x), y: Number(action.y), button: action.button || 'left' };
  }
  if (type === 'type') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error('type requires ref, selector, role, or targetText');
    await locator.fill(String(action.text || ''), { timeout });
    return { type, chars: String(action.text || '').length };
  }
  if (type === 'press') {
    const locator = resolveBrowserLocator(metadata, action);
    const key = String(action.key || '');
    if (!key) throw new Error('press requires key');
    if (locator) await locator.press(key, { timeout }); else await page.keyboard.press(key);
    return { type, key };
  }
  if (type === 'focus' || type === 'hover') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error(`${type} requires ref, selector, role, or targetText`);
    if (type === 'focus') await locator.focus({ timeout }); else await locator.hover({ timeout });
    return { type };
  }
  if (type === 'scroll') {
    const locator = resolveBrowserLocator(metadata, action);
    if (locator) { await locator.scrollIntoViewIfNeeded({ timeout }); return { type, target: action.ref || action.selector || action.role || action.targetText }; }
    const deltaX = Number(action.deltaX) || 0;
    const deltaY = Number(action.deltaY) || 0;
    await page.mouse.wheel(deltaX, deltaY);
    return { type, deltaX, deltaY };
  }
  if (type === 'select') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error('select requires ref, selector, role, or targetText');
    const values = Array.isArray(action.values) ? action.values.map(String) : [String(action.value ?? '')];
    return { type, selected: await locator.selectOption(values, { timeout }) };
  }
  if (type === 'check' || type === 'uncheck') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error(`${type} requires ref, selector, role, or targetText`);
    if (type === 'check') await locator.check({ timeout }); else await locator.uncheck({ timeout });
    return { type };
  }
  if (type === 'drag') {
    const sourceLocator = resolveBrowserLocator(metadata, action);
    const targetLocator = resolveBrowserTargetLocator(metadata, action);
    if (sourceLocator && targetLocator && typeof sourceLocator.dragTo === 'function') {
      await sourceLocator.dragTo(targetLocator, { timeout });
      return { type, source: action.ref || action.selector || action.role || action.targetText, target: action.targetRef || action.targetSelector || action.targetRole || action.targetTargetText };
    }
    const source = sourceLocator
      ? await locatorPoint(sourceLocator, 'Drag source')
      : (action.x != null && action.y != null ? { x: Number(action.x), y: Number(action.y) } : null);
    const target = targetLocator
      ? await locatorPoint(targetLocator, 'Drag target')
      : (action.targetX != null && action.targetY != null ? { x: Number(action.targetX), y: Number(action.targetY) } : null);
    if (!source || !target) throw new Error('drag requires source and target locators or coordinates');
    await dragWithMouse(page, source, target);
    return { type, source, target };
  }
  if (type === 'upload') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error('upload requires ref, selector, role, or targetText for a file input');
    const paths = Array.isArray(action.paths) ? action.paths : [];
    if (paths.length === 0) throw new Error('upload requires at least one workspace-relative path');
    const files = paths.map((item, index) => safeBrowserWorkspaceInput(session.workspaceRoot, item, `Browser upload ${index + 1}`));
    await locator.setInputFiles(files.map(item => item.resolved), { timeout });
    return { type, paths: files.map(item => item.relative), count: files.length };
  }
  if (type === 'download') {
    const locator = resolveBrowserLocator(metadata, action);
    if (!locator) throw new Error('download requires ref, selector, role, or targetText for the download trigger');
    const output = safeBrowserWorkspaceOutput(session.workspaceRoot, action.path, 'Browser download');
    await fsp.mkdir(path.dirname(output.resolved), { recursive: true });
    const pending = page.waitForEvent('download', { timeout });
    try {
      await locator.click({ button: action.button || 'left', timeout });
      const download = await pending;
      await download.saveAs(output.resolved);
      return { type, path: output.relative, suggestedFilename: String(download.suggestedFilename?.() || '').slice(0, 500) || null };
    } catch (error) {
      void pending.catch(() => {});
      throw error;
    }
  }
  if (type === 'open_tab') {
    if (session.pages.size >= MAX_TABS_PER_SESSION) throw new Error(`Browser control tab limit reached (${MAX_TABS_PER_SESSION})`);
    const next = await session.context.newPage();
    const nextMetadata = registerBrowserPage(session, next);
    if (action.url) await browserNavigate(next, action.url, session.allowRemoteUrls, timeout);
    await next.bringToFront().catch(() => {});
    return { type, tab: await browserTabSummary(nextMetadata, session.activeTabId) };
  }
  if (type === 'switch_tab') {
    const next = getBrowserPage(session, action.targetTabId);
    await next.page.bringToFront().catch(() => {});
    return { type, tab: await browserTabSummary(next, session.activeTabId) };
  }
  if (type === 'close_tab') {
    const closing = action.targetTabId ? getBrowserPage(session, action.targetTabId) : metadata;
    const id = closing.id;
    await closing.page.close();
    return { type, closedTabId: id, activeTabId: session.activeTabId };
  }
  if (type === 'screenshot') {
    const output = safeBrowserWorkspaceOutput(session.workspaceRoot, action.path || 'artifacts/browser-control/latest.png', 'Browser screenshot');
    await fsp.mkdir(path.dirname(output.resolved), { recursive: true });
    await page.screenshot({ path: output.resolved, fullPage: !!action.fullPage });
    return { type, path: output.relative, fullPage: !!action.fullPage };
  }
  throw new Error(`Unsupported browser control action: ${type || '(empty)'}`);
}

export async function actBrowserControl({ workspaceId, sessionId, tabId = '', action }) {
  const session = getBrowserSession(sessionId, workspaceId);
  assertBrowserAgentControl(session);
  const metadata = getBrowserPage(session, tabId);
  const normalizedAction = action || {};
  const result = await performAction(session, metadata, normalizedAction);
  if (!['screenshot', 'switch_tab'].includes(String(normalizedAction.type || ''))) invalidateBrowserSnapshot(metadata);
  session.lastUsedAt = new Date().toISOString();
  let tab = null;
  if (!metadata.page.isClosed()) tab = await browserTabSummary(metadata, session.activeTabId);
  return { result, tab, session: await browserSessionSummary(session), snapshotInvalidated: metadata.snapshotId == null };
}

export const __test = { dragWithMouse, locatorPoint, performAction };
