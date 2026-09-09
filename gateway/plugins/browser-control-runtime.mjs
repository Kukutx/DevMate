import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isLoopbackHostname } from '../http-host-policy.mjs';
import { sensitiveWorkspacePathReason } from '../sensitive-path-policy.mjs';

const MAX_SESSIONS = 4;
const MAX_TABS_PER_SESSION = 16;
const MAX_LOG_ENTRIES = 100;
const DEFAULT_SNAPSHOT_ELEMENTS = 120;
const MAX_SNAPSHOT_ELEMENTS = 250;
const DEFAULT_BODY_CHARS = 12000;
const MAX_BODY_CHARS = 30000;
const sessions = new Map();

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function resolveContainedWorkspacePath(workspaceRoot, candidatePath, label, { mustExist = false } = {}) {
  const root = fs.realpathSync.native(workspaceRoot);
  const candidate = path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(root, candidatePath || '.');
  if (!isInside(root, candidate)) throw new Error(`${label} path escapes workspace root`);
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, candidate));
  if (!isInside(root, resolved)) throw new Error(`${label} path escapes workspace root through symlink/reparse point`);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (mustExist && !stat) throw new Error(`${label} path not found: ${candidatePath}`);
  return resolved;
}

function safeWorkspaceOutput(workspaceRoot, relativePath, label) {
  const value = String(relativePath || '').trim();
  if (!value) throw new Error(`${label} path is required`);
  const root = fs.realpathSync.native(workspaceRoot);
  const resolved = resolveContainedWorkspacePath(root, value, label);
  const relative = path.relative(root, resolved).replace(/\\/g, '/');
  const reason = sensitiveWorkspacePathReason(relative);
  if (reason) throw new Error(`${label} path targets protected workspace data (${reason}): ${relative}`);
  return { resolved, relative };
}

function browserExecutableAllowed(value) {
  if (!value) return true;
  const base = path.basename(String(value).replace(/\\/g, '/')).toLowerCase();
  return /^(?:google chrome|chrome|chrome-headless-shell|chromium|chromium-browser|msedge)(?:\.exe)?$/.test(base);
}

function resolveModuleFromWorkspace(workspaceRoot, configuredPath = '') {
  const root = fs.realpathSync.native(workspaceRoot);
  if (configuredPath) return resolveContainedWorkspacePath(root, configuredPath, 'Configured Playwright module', { mustExist: true });
  const requireFromWorkspace = createRequire(path.join(root, 'package.json'));
  for (const name of ['playwright', 'playwright-core']) {
    try {
      const resolved = requireFromWorkspace.resolve(name);
      return resolveContainedWorkspacePath(root, resolved, `Resolved ${name} module`, { mustExist: true });
    } catch {}
  }
  return null;
}

export function browserControlStatus(workspaceRoot, settings = {}) {
  let modulePath = null;
  let error = null;
  try { modulePath = resolveModuleFromWorkspace(workspaceRoot, settings.playwrightModulePath || ''); }
  catch (cause) { error = cause.message; }
  const executablePath = String(settings.chromiumExecutablePath || '').trim();
  const executableAllowed = browserExecutableAllowed(executablePath);
  const executableExists = !executablePath || !!fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile();
  return {
    available: !!modulePath && executableAllowed && executableExists,
    modulePath,
    moduleConfigured: !!settings.playwrightModulePath,
    chromiumExecutablePath: executablePath || null,
    chromiumExecutableExists: executableExists,
    chromiumExecutableAllowed: executableAllowed,
    allowRemoteUrls: !!settings.allowRemoteUrls,
    defaultHeadless: !!settings.defaultHeadless,
    maxSessions: MAX_SESSIONS,
    activeSessions: sessions.size,
    error: error || (!executableAllowed
      ? `Configured browser executable is not Chrome/Chromium/Edge: ${executablePath}`
      : !executableExists ? `Chromium executable not found: ${executablePath}` : null)
  };
}

async function loadPlaywright(workspaceRoot, settings) {
  const modulePath = resolveModuleFromWorkspace(workspaceRoot, settings.playwrightModulePath || '');
  if (!modulePath) throw new Error('Playwright is not installed in the active workspace. Install playwright or playwright-core first.');
  const imported = await import(pathToFileURL(modulePath).href);
  const api = imported.default || imported;
  if (!api?.chromium) throw new Error(`Playwright module does not expose chromium: ${modulePath}`);
  return { api, modulePath };
}

function assertAllowedUrl(rawUrl, allowRemoteUrls) {
  const url = new URL(String(rawUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported browser URL protocol: ${url.protocol}`);
  if (!allowRemoteUrls && !isLoopbackHostname(url.hostname)) {
    throw new Error('Remote browser URLs are disabled. Use a loopback URL or explicitly enable allowRemoteUrls for devmate.browser-control.');
  }
  return url;
}

function requestUrlAllowed(rawUrl, allowRemoteUrls) {
  const value = String(rawUrl || '');
  if (/^(?:data:|blob:|about:)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && (allowRemoteUrls || isLoopbackHostname(parsed.hostname));
  } catch { return false; }
}

function pushBounded(items, value) {
  items.push(value);
  if (items.length > MAX_LOG_ENTRIES) items.splice(0, items.length - MAX_LOG_ENTRIES);
}

function pageMetadata(session, page) {
  const id = session.pageIds.get(page);
  return id ? session.pages.get(id) || null : null;
}

function registerPage(session, page) {
  const existing = pageMetadata(session, page);
  if (existing) return existing;
  if (session.pages.size >= MAX_TABS_PER_SESSION) {
    void page.close().catch(() => {});
    throw new Error(`Browser control tab limit reached (${MAX_TABS_PER_SESSION})`);
  }
  const id = `tab-${session.nextTabId++}`;
  const metadata = { id, page, snapshotCounter: 0, snapshotId: null, refs: new Map(), console: [], pageErrors: [], requestFailures: [] };
  session.pageIds.set(page, id);
  session.pages.set(id, metadata);
  session.activeTabId = id;
  page.on('console', message => {
    const type = message.type();
    if (['warning', 'error'].includes(type)) pushBounded(metadata.console, { type, text: String(message.text() || '').slice(0, 4000) });
  });
  page.on('pageerror', error => pushBounded(metadata.pageErrors, String(error?.stack || error?.message || error).slice(0, 8000)));
  page.on('requestfailed', request => pushBounded(metadata.requestFailures, {
    url: String(request.url() || '').slice(0, 4000),
    method: String(request.method() || '').slice(0, 20),
    error: String(request.failure()?.errorText || 'failed').slice(0, 1000)
  }));
  page.once('close', () => {
    session.pages.delete(id);
    metadata.refs.clear();
    if (session.activeTabId === id) session.activeTabId = session.pages.keys().next().value || null;
  });
  return metadata;
}

function getSession(sessionId, workspaceId) {
  const id = String(sessionId || '').trim();
  const session = sessions.get(id);
  if (!session) throw new Error(`Unknown browser control session: ${id || '(empty)'}`);
  if (workspaceId && session.workspaceId !== workspaceId) throw new Error(`Browser control session ${id} belongs to workspace ${session.workspaceId}, not ${workspaceId}`);
  if (!session.browser?.isConnected()) {
    sessions.delete(id);
    throw new Error(`Browser control session is no longer connected: ${id}`);
  }
  session.lastUsedAt = new Date().toISOString();
  return session;
}

function getPage(session, tabId = '') {
  const requested = String(tabId || '').trim();
  const id = requested || session.activeTabId;
  const metadata = id ? session.pages.get(id) : null;
  if (!metadata) throw new Error(`Unknown browser tab: ${requested || '(active)'}`);
  session.activeTabId = metadata.id;
  return metadata;
}

async function tabSummary(metadata, activeTabId) {
  let title = '';
  try { title = String(await metadata.page.title() || '').slice(0, 1000); } catch {}
  return { id: metadata.id, active: metadata.id === activeTabId, url: String(metadata.page.url() || '').slice(0, 4000), title };
}

async function sessionSummary(session) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    headless: session.headless,
    allowRemoteUrls: session.allowRemoteUrls,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    activeTabId: session.activeTabId,
    tabCount: session.pages.size,
    tabs: await Promise.all([...session.pages.values()].map(metadata => tabSummary(metadata, session.activeTabId)))
  };
}

export async function browserControlSessions(workspaceId = '') {
  const target = String(workspaceId || '').trim();
  return Promise.all([...sessions.values()].filter(session => !target || session.workspaceId === target).map(sessionSummary));
}

export async function startBrowserControl({ workspaceId, workspaceRoot, settings = {}, url = '', headless, viewport = {} }) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`Browser control session limit reached (${MAX_SESSIONS})`);
  const allowRemoteUrls = !!settings.allowRemoteUrls;
  const initialUrl = String(url || '').trim();
  const targetUrl = initialUrl ? assertAllowedUrl(initialUrl, allowRemoteUrls) : null;
  const { api, modulePath } = await loadPlaywright(workspaceRoot, settings);
  const resolvedHeadless = headless == null ? !!settings.defaultHeadless : !!headless;
  const launchOptions = { headless: resolvedHeadless };
  if (settings.chromiumExecutablePath) {
    if (!browserExecutableAllowed(settings.chromiumExecutablePath)) throw new Error('Configured browser executable must be Chrome, Chromium, Chrome Headless Shell, or Edge');
    launchOptions.executablePath = settings.chromiumExecutablePath;
  }
  const browser = await api.chromium.launch(launchOptions);
  let context = null;
  let session = null;
  try {
    context = await browser.newContext({
      acceptDownloads: false,
      viewport: {
        width: Math.min(3840, Math.max(320, Number(viewport.width) || 1280)),
        height: Math.min(2160, Math.max(240, Number(viewport.height) || 720))
      }
    });
    if (!allowRemoteUrls) {
      await context.route('**/*', async route => requestUrlAllowed(route.request().url(), false) ? route.continue() : route.abort('blockedbyclient'));
    }
    const id = `browser-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    session = {
      id, workspaceId, workspaceRoot, browser, context, modulePath, headless: resolvedHeadless, allowRemoteUrls,
      createdAt: now, lastUsedAt: now, activeTabId: null, nextTabId: 1, pages: new Map(), pageIds: new WeakMap()
    };
    sessions.set(id, session);
    context.on('page', page => { try { registerPage(session, page); } catch {} });
    browser.once('disconnected', () => { if (sessions.get(id) === session) sessions.delete(id); });
    const page = await context.newPage();
    registerPage(session, page);
    if (targetUrl) await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { session: await sessionSummary(session), modulePath };
  } catch (error) {
    if (session) sessions.delete(session.id);
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

export async function stopBrowserControl({ workspaceId, sessionId }) {
  const session = getSession(sessionId, workspaceId);
  sessions.delete(session.id);
  session.pages.clear();
  try { await session.context.close(); } catch {}
  try { await session.browser.close(); } catch {}
  return { stopped: true, id: session.id, workspaceId: session.workspaceId };
}

export async function shutdownBrowserControl() {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.all(active.map(async session => {
    session.pages.clear();
    try { await session.context.close(); } catch {}
    try { await session.browser.close(); } catch {}
  }));
}

export async function listBrowserTabs({ workspaceId, sessionId }) {
  return sessionSummary(getSession(sessionId, workspaceId));
}

function resolvedLocator(metadata, action) {
  const page = metadata.page;
  if (action.ref) {
    if (!action.snapshotId || action.snapshotId !== metadata.snapshotId) throw new Error('Browser element ref is stale or missing snapshotId; take a new browser_control_snapshot and use its snapshotId');
    const selector = metadata.refs.get(String(action.ref));
    if (!selector) throw new Error(`Unknown browser element ref: ${action.ref}`);
    return page.locator(selector);
  }
  if (action.selector) return page.locator(String(action.selector));
  if (action.role) return page.getByRole(String(action.role), { ...(action.name != null ? { name: String(action.name) } : {}), exact: !!action.exact });
  if (action.targetText) return page.getByText(String(action.targetText), { exact: !!action.exact });
  return null;
}

function actionTimeout(action) { return Math.min(30000, Math.max(100, Number(action.timeoutMs) || 10000)); }
function invalidateSnapshot(metadata) { metadata.snapshotId = null; metadata.refs.clear(); }

async function navigate(page, rawUrl, allowRemoteUrls, timeoutMs) {
  const target = assertAllowedUrl(rawUrl, allowRemoteUrls);
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  return { url: page.url(), status: response?.status?.() ?? null };
}

async function performAction(session, metadata, action) {
  const page = metadata.page;
  const type = String(action.type || '').trim();
  const timeout = actionTimeout(action);
  if (type === 'navigate') return { type, ...(await navigate(page, action.url, session.allowRemoteUrls, timeout)) };
  if (type === 'back') { const response = await page.goBack({ waitUntil: 'domcontentloaded', timeout }); return { type, url: page.url(), status: response?.status?.() ?? null }; }
  if (type === 'forward') { const response = await page.goForward({ waitUntil: 'domcontentloaded', timeout }); return { type, url: page.url(), status: response?.status?.() ?? null }; }
  if (type === 'reload') { const response = await page.reload({ waitUntil: 'domcontentloaded', timeout }); return { type, url: page.url(), status: response?.status?.() ?? null }; }
  if (type === 'wait') { const ms = Math.min(30000, Math.max(0, Number(action.ms) || 0)); await page.waitForTimeout(ms); return { type, ms }; }
  if (type === 'wait_for') {
    const locator = resolvedLocator(metadata, action);
    if (!locator) throw new Error('wait_for requires ref, selector, role, or targetText');
    await locator.waitFor({ state: action.state || 'visible', timeout });
    return { type, state: action.state || 'visible' };
  }
  if (type === 'click') {
    const locator = resolvedLocator(metadata, action);
    if (locator) { await locator.click({ button: action.button || 'left', timeout }); return { type, target: action.ref || action.selector || action.role || action.targetText }; }
    if (action.x == null || action.y == null) throw new Error('click requires a target or x/y coordinates');
    await page.mouse.click(Number(action.x), Number(action.y), { button: action.button || 'left' });
    return { type, x: Number(action.x), y: Number(action.y), button: action.button || 'left' };
  }
  if (type === 'type') {
    const locator = resolvedLocator(metadata, action);
    if (!locator) throw new Error('type requires ref, selector, role, or targetText');
    await locator.fill(String(action.text || ''), { timeout });
    return { type, chars: String(action.text || '').length };
  }
  if (type === 'press') {
    const locator = resolvedLocator(metadata, action);
    const key = String(action.key || '');
    if (!key) throw new Error('press requires key');
    if (locator) await locator.press(key, { timeout }); else await page.keyboard.press(key);
    return { type, key };
  }
  if (type === 'focus' || type === 'hover') {
    const locator = resolvedLocator(metadata, action);
    if (!locator) throw new Error(`${type} requires ref, selector, role, or targetText`);
    if (type === 'focus') await locator.focus({ timeout }); else await locator.hover({ timeout });
    return { type };
  }
  if (type === 'scroll') {
    const locator = resolvedLocator(metadata, action);
    if (locator) { await locator.scrollIntoViewIfNeeded({ timeout }); return { type, target: action.ref || action.selector || action.role || action.targetText }; }
    const deltaX = Number(action.deltaX) || 0;
    const deltaY = Number(action.deltaY) || 0;
    await page.mouse.wheel(deltaX, deltaY);
    return { type, deltaX, deltaY };
  }
  if (type === 'select') {
    const locator = resolvedLocator(metadata, action);
    if (!locator) throw new Error('select requires ref, selector, role, or targetText');
    const values = Array.isArray(action.values) ? action.values.map(String) : [String(action.value ?? '')];
    return { type, selected: await locator.selectOption(values, { timeout }) };
  }
  if (type === 'check' || type === 'uncheck') {
    const locator = resolvedLocator(metadata, action);
    if (!locator) throw new Error(`${type} requires ref, selector, role, or targetText`);
    if (type === 'check') await locator.check({ timeout }); else await locator.uncheck({ timeout });
    return { type };
  }
  if (type === 'open_tab') {
    if (session.pages.size >= MAX_TABS_PER_SESSION) throw new Error(`Browser control tab limit reached (${MAX_TABS_PER_SESSION})`);
    const next = await session.context.newPage();
    const nextMetadata = registerPage(session, next);
    if (action.url) await navigate(next, action.url, session.allowRemoteUrls, timeout);
    await next.bringToFront().catch(() => {});
    return { type, tab: await tabSummary(nextMetadata, session.activeTabId) };
  }
  if (type === 'switch_tab') {
    const next = getPage(session, action.targetTabId);
    await next.page.bringToFront().catch(() => {});
    return { type, tab: await tabSummary(next, session.activeTabId) };
  }
  if (type === 'close_tab') {
    const closing = action.targetTabId ? getPage(session, action.targetTabId) : metadata;
    const id = closing.id;
    await closing.page.close();
    return { type, closedTabId: id, activeTabId: session.activeTabId };
  }
  if (type === 'screenshot') {
    const output = safeWorkspaceOutput(session.workspaceRoot, action.path || 'artifacts/browser-control/latest.png', 'Browser screenshot');
    await fsp.mkdir(path.dirname(output.resolved), { recursive: true });
    await page.screenshot({ path: output.resolved, fullPage: !!action.fullPage });
    return { type, path: output.relative, fullPage: !!action.fullPage };
  }
  throw new Error(`Unsupported browser control action: ${type || '(empty)'}`);
}

export async function actBrowserControl({ workspaceId, sessionId, tabId = '', action }) {
  const session = getSession(sessionId, workspaceId);
  const metadata = getPage(session, tabId);
  const normalizedAction = action || {};
  const result = await performAction(session, metadata, normalizedAction);
  if (!['screenshot', 'switch_tab'].includes(String(normalizedAction.type || ''))) invalidateSnapshot(metadata);
  session.lastUsedAt = new Date().toISOString();
  let tab = null;
  if (!metadata.page.isClosed()) tab = await tabSummary(metadata, session.activeTabId);
  return { result, tab, session: await sessionSummary(session), snapshotInvalidated: metadata.snapshotId == null };
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

export async function snapshotBrowserControl({ workspaceId, sessionId, tabId = '', maxElements = DEFAULT_SNAPSHOT_ELEMENTS, bodyChars = DEFAULT_BODY_CHARS }) {
  const session = getSession(sessionId, workspaceId);
  const metadata = getPage(session, tabId);
  const page = metadata.page;
  const elementLimit = clampInt(maxElements, DEFAULT_SNAPSHOT_ELEMENTS, 1, MAX_SNAPSHOT_ELEMENTS);
  const textLimit = clampInt(bodyChars, DEFAULT_BODY_CHARS, 1000, MAX_BODY_CHARS);
  const state = await page.evaluate(({ elementLimit, textLimit }) => {
    const compact = (value, max = 500) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
    const visible = element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const cssIdent = value => globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
    const cssString = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\a ')}"`;
    const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
    const cssPath = element => {
      if (element.id) { const selector = `#${cssIdent(element.id)}`; if (unique(selector)) return selector; }
      for (const attr of ['data-testid', 'data-test', 'data-qa', 'aria-label', 'name']) {
        const value = element.getAttribute(attr);
        if (!value) continue;
        const selector = `${element.tagName.toLowerCase()}[${attr}=${cssString(value)}]`;
        if (unique(selector)) return selector;
      }
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && current !== document.documentElement && parts.length < 10) {
        let part = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(item => item.tagName === current.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(' > ');
    };
    const roleFor = element => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
      if (tag === 'input') {
        const type = String(element.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
      return tag;
    };
    const nameFor = element => {
      const labelledBy = String(element.getAttribute('aria-labelledby') || '').trim();
      if (labelledBy) {
        const labelled = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
        if (compact(labelled)) return compact(labelled);
      }
      const labels = element.labels ? [...element.labels].map(label => label.innerText || '').join(' ') : '';
      return compact(element.getAttribute('aria-label') || labels || element.getAttribute('alt') || element.getAttribute('title') || element.getAttribute('placeholder') || element.getAttribute('name') || element.innerText || element.textContent);
    };
    const selector = ['a[href]', 'button', 'input:not([type="hidden"])', 'textarea', 'select', 'summary', '[role]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'].join(',');
    const candidates = [...document.querySelectorAll(selector)].filter(visible).slice(0, elementLimit);
    const elements = candidates.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        ref: `e${index + 1}`,
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        role: roleFor(element),
        name: nameFor(element),
        text: compact(element.innerText || element.textContent),
        href: element instanceof HTMLAnchorElement ? String(element.href || '').slice(0, 2000) : null,
        type: element instanceof HTMLInputElement ? String(element.type || '') : null,
        disabled: 'disabled' in element ? !!element.disabled : null,
        checked: 'checked' in element ? !!element.checked : null,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    });
    return { title: compact(document.title, 1000), readyState: document.readyState, bodyText: String(document.body?.innerText || '').slice(0, textLimit), elements };
  }, { elementLimit, textLimit });

  metadata.refs.clear();
  for (const element of state.elements || []) if (element.ref && element.selector) metadata.refs.set(element.ref, element.selector);
  metadata.snapshotCounter += 1;
  metadata.snapshotId = `${metadata.id}-snapshot-${metadata.snapshotCounter}`;
  let ariaSnapshot = null;
  try {
    const body = page.locator('body');
    if (typeof body.ariaSnapshot === 'function') ariaSnapshot = String(await body.ariaSnapshot({ timeout: 5000 }) || '').slice(0, MAX_BODY_CHARS);
  } catch {}
  const frames = page.frames().slice(0, 20).map((frame, index) => ({ index, name: String(frame.name() || '').slice(0, 500), url: String(frame.url() || '').slice(0, 4000) }));
  session.lastUsedAt = new Date().toISOString();
  return {
    sessionId: session.id,
    tabId: metadata.id,
    snapshotId: metadata.snapshotId,
    url: String(page.url() || '').slice(0, 4000),
    title: state.title,
    readyState: state.readyState,
    bodyText: state.bodyText,
    ariaSnapshot,
    elements: state.elements,
    frames,
    diagnostics: { console: metadata.console.slice(-30), pageErrors: metadata.pageErrors.slice(-30), requestFailures: metadata.requestFailures.slice(-30) }
  };
}

export const __test = { MAX_SESSIONS, MAX_TABS_PER_SESSION, assertAllowedUrl, browserExecutableAllowed, requestUrlAllowed, resolveModuleFromWorkspace };
