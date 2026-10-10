import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isLoopbackHostname } from '../platform/http-host-policy.mjs';
import { sensitiveWorkspacePathReason } from '../platform/sensitive-path-policy.mjs';

export const MAX_SESSIONS = 4;
export const MAX_TABS_PER_SESSION = 16;
export const MAX_LOG_ENTRIES = 100;
export const DEFAULT_SNAPSHOT_ELEMENTS = 120;
export const MAX_SNAPSHOT_ELEMENTS = 250;
export const DEFAULT_BODY_CHARS = 12000;
export const MAX_BODY_CHARS = 30000;
export const MAX_INLINE_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export function createBrowserControlState({ stateRoot = '' } = {}) {
  return { stateRoot: stateRoot ? path.resolve(stateRoot) : '', sessions: new Map(), persistentProfileOwners: new Map(),
    pendingSessionStarts: 0, pendingStarts: new Set(), resources: new Set(), closing: false };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function resolveContainedWorkspacePath(workspaceRoot, candidatePath, label, { mustExist = false } = {}) {
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

function safeWorkspacePath(workspaceRoot, candidatePath, label, { mustExist = false, file = false } = {}) {
  const root = fs.realpathSync.native(workspaceRoot);
  const resolved = resolveContainedWorkspacePath(root, candidatePath, label, { mustExist });
  const relative = path.relative(root, resolved).replace(/\\/g, '/');
  const reason = sensitiveWorkspacePathReason(relative);
  if (reason) throw new Error(`${label} path targets protected workspace data (${reason}): ${relative}`);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (file && stat && !stat.isFile()) throw new Error(`${label} path is not a file: ${relative}`);
  return { resolved, relative };
}

export function safeBrowserWorkspaceOutput(workspaceRoot, relativePath, label) {
  const value = String(relativePath || '').trim();
  if (!value) throw new Error(`${label} path is required`);
  return safeWorkspacePath(workspaceRoot, value, label);
}

export function safeBrowserWorkspaceInput(workspaceRoot, relativePath, label = 'Browser upload') {
  const value = String(relativePath || '').trim();
  if (!value) throw new Error(`${label} path is required`);
  return safeWorkspacePath(workspaceRoot, value, label, { mustExist: true, file: true });
}

export function browserExecutableAllowed(value) {
  if (!value) return true;
  const base = path.basename(String(value).replace(/\\/g, '/')).toLowerCase();
  return /^(?:google chrome|google chrome for testing|chrome|chrome-headless-shell|chromium|chromium-browser|google-chrome(?:-stable|-beta|-unstable)?|microsoft edge|microsoft-edge(?:-stable|-beta|-dev)?|msedge)(?:\.exe)?$/.test(base);
}

export function resolveModuleFromWorkspace(workspaceRoot, configuredPath = '') {
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

export function assertAllowedUrl(rawUrl, allowRemoteUrls) {
  const url = new URL(String(rawUrl || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported browser URL protocol: ${url.protocol}`);
  if (!allowRemoteUrls && !isLoopbackHostname(url.hostname)) {
    throw new Error('Remote browser URLs are disabled. Use a loopback URL, or the owner enables them with capability.configure {engine:"browser-control", settings:{allowRemoteUrls:true}}.');
  }
  return url;
}

export function requestUrlAllowed(rawUrl, allowRemoteUrls) {
  const value = String(rawUrl || '');
  if (/^(?:data:|blob:|about:)/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) && (allowRemoteUrls || isLoopbackHostname(parsed.hostname));
  } catch { return false; }
}

export function webSocketUrlAllowed(rawUrl, allowRemoteUrls) {
  try {
    const parsed = new URL(String(rawUrl || ''));
    return ['ws:', 'wss:'].includes(parsed.protocol) && (allowRemoteUrls || isLoopbackHostname(parsed.hostname));
  } catch { return false; }
}

async function loadPlaywright(workspaceRoot, settings) {
  const modulePath = resolveModuleFromWorkspace(workspaceRoot, settings.playwrightModulePath || '');
  if (!modulePath) throw new Error('Playwright is not installed in the active workspace. Install playwright or playwright-core first.');
  const imported = await import(pathToFileURL(modulePath).href);
  const api = imported.default || imported;
  if (!api?.chromium) throw new Error(`Playwright module does not expose chromium: ${modulePath}`);
  return { api, modulePath };
}

function pushBounded(items, value) {
  items.push(value);
  if (items.length > MAX_LOG_ENTRIES) items.splice(0, items.length - MAX_LOG_ENTRIES);
}

function pageMetadata(session, page) {
  const id = session.pageIds.get(page);
  return id ? session.pages.get(id) || null : null;
}

export function registerBrowserPage(session, page) {
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
  page.on?.('console', message => {
    const type = message.type();
    if (['warning', 'error'].includes(type)) pushBounded(metadata.console, { type, text: String(message.text() || '').slice(0, 4000) });
  });
  page.on?.('pageerror', error => pushBounded(metadata.pageErrors, String(error?.stack || error?.message || error).slice(0, 8000)));
  page.on?.('requestfailed', request => pushBounded(metadata.requestFailures, {
    url: String(request.url() || '').slice(0, 4000),
    method: String(request.method() || '').slice(0, 20),
    error: String(request.failure()?.errorText || 'failed').slice(0, 1000)
  }));
  page.once?.('close', () => {
    session.pages.delete(id);
    metadata.refs.clear();
    if (session.activeTabId === id) session.activeTabId = session.pages.keys().next().value || null;
  });
  return metadata;
}

function profileKey(workspaceId, workspaceRoot) {
  const root = fs.realpathSync.native(workspaceRoot);
  return crypto.createHash('sha256').update(`${String(workspaceId || '')}\0${root}`).digest('hex').slice(0, 32);
}

async function persistentProfileDirectory(state, workspaceId, workspaceRoot) {
  if (!state.stateRoot) throw new Error('Persistent Browser Control profiles require an explicit private state directory');
  const key = profileKey(workspaceId, workspaceRoot);
  const directory = path.join(state.stateRoot, 'profiles', key);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(directory, 0o700); } catch {}
  return { key, directory };
}

function releasePersistentProfile(state, session) {
  if (!session?.profileKey || session.profileReleased) return;
  if (state.persistentProfileOwners.get(session.profileKey) === session.id) state.persistentProfileOwners.delete(session.profileKey);
  session.profileReleased = true;
}

function cleanupSession(state, session, { releaseProfile = true } = {}) {
  if (!session) return;
  if (!session.cleanedUp) {
    session.cleanedUp = true;
    session.closed = true;
    state.sessions.delete(session.id);
    for (const metadata of session.pages.values()) metadata.refs.clear();
    session.pages.clear();
  }
  if (releaseProfile) releasePersistentProfile(state, session);
}

export function getBrowserSession(state, sessionId, workspaceId) {
  const id = String(sessionId || '').trim();
  const session = state.sessions.get(id);
  if (!session || session.closed) throw new Error(`Unknown browser control session: ${id || '(empty)'}`);
  if (workspaceId && session.workspaceId !== workspaceId) throw new Error(`Browser control session ${id} belongs to workspace ${session.workspaceId}, not ${workspaceId}`);
  if (session.browser?.isConnected && !session.browser.isConnected()) {
    session.closed = true;
    throw new Error(`Browser control session is no longer connected: ${id}`);
  }
  session.lastUsedAt = new Date().toISOString();
  return session;
}

export function getBrowserPage(session, tabId = '') {
  const requested = String(tabId || '').trim();
  const id = requested || session.activeTabId;
  const metadata = id ? session.pages.get(id) : null;
  if (!metadata) throw new Error(`Unknown browser tab: ${requested || '(active)'}`);
  session.activeTabId = metadata.id;
  return metadata;
}

export async function browserTabSummary(metadata, activeTabId) {
  let title = '';
  try { title = String(await metadata.page.title() || '').slice(0, 1000); } catch {}
  return { id: metadata.id, active: metadata.id === activeTabId, url: String(metadata.page.url() || '').slice(0, 4000), title };
}

export async function browserSessionSummary(session) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    headless: session.headless,
    allowRemoteUrls: session.allowRemoteUrls,
    profileMode: session.profileMode,
    controlMode: session.controlMode,
    closed: session.closed,
    ...(session.closeError ? { closeError: session.closeError } : {}),
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    activeTabId: session.activeTabId,
    tabCount: session.pages.size,
    tabs: await Promise.all([...session.pages.values()].map(metadata => browserTabSummary(metadata, session.activeTabId)))
  };
}

export function browserControlStatus(state, workspaceRoot, settings = {}) {
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
    persistentProfilesAvailable: !!state.stateRoot,
    activePersistentProfiles: [...state.persistentProfileOwners.values()].filter(owner => !String(owner).startsWith('starting-')).length,
    startingPersistentProfiles: [...state.persistentProfileOwners.values()].filter(owner => String(owner).startsWith('starting-')).length,
    maxSessions: MAX_SESSIONS,
    activeSessions: state.sessions.size,
    startingSessions: state.pendingSessionStarts,
    error: error || (!executableAllowed
      ? `Configured browser executable is not Chrome/Chromium/Edge: ${executablePath}`
      : !executableExists ? `Chromium executable not found: ${executablePath}` : null)
  };
}

export async function browserControlSessions(state, workspaceId = '') {
  const target = String(workspaceId || '').trim();
  return Promise.all([...state.sessions.values()].filter(session => !target || session.workspaceId === target).map(browserSessionSummary));
}

function viewportOptions(viewport = {}) {
  return {
    width: Math.min(3840, Math.max(320, Number(viewport.width) || 1280)),
    height: Math.min(2160, Math.max(240, Number(viewport.height) || 720))
  };
}

export async function startBrowserControl(state, { workspaceId, workspaceRoot, settings = {}, url = '', headless, viewport = {}, profileMode = 'ephemeral' }) {
  if (state.closing) throw new Error('Browser Control engine is closed');
  if (state.sessions.size + state.pendingSessionStarts >= MAX_SESSIONS) throw new Error(`Browser control session limit reached (${MAX_SESSIONS})`);
  const resolvedProfileMode = String(profileMode || 'ephemeral');
  if (!['ephemeral', 'workspace'].includes(resolvedProfileMode)) throw new Error(`Unsupported Browser Control profile mode: ${resolvedProfileMode}`);
  const allowRemoteUrls = !!settings.allowRemoteUrls;
  const initialUrl = String(url || '').trim();
  const targetUrl = initialUrl ? assertAllowedUrl(initialUrl, allowRemoteUrls) : null;
  state.pendingSessionStarts += 1;
  let finishStart;
  const completion = new Promise(resolve => { finishStart = resolve; });
  state.pendingStarts.add(completion);
  const resource = { browser: null, context: null, session: null, profile: null, closing: null };
  state.resources.add(resource);
  let browser = null;
  let context = null;
  let session = null;
  let profile = null;
  let profileReservation = null;
  try {
    const { api, modulePath } = await loadPlaywright(workspaceRoot, settings);
    if (state.closing) throw new Error('Browser Control engine stopped during startup');
    const resolvedHeadless = headless == null ? !!settings.defaultHeadless : !!headless;
    const launchOptions = { headless: resolvedHeadless };
    if (settings.chromiumExecutablePath) {
      if (!browserExecutableAllowed(settings.chromiumExecutablePath)) throw new Error('Configured browser executable must be Chrome, Chromium, Chrome Headless Shell, or Edge');
      launchOptions.executablePath = settings.chromiumExecutablePath;
    }
    const contextOptions = {
      acceptDownloads: true,
      viewport: viewportOptions(viewport),
      ...(!allowRemoteUrls ? { serviceWorkers: 'block' } : {})
    };
    if (resolvedProfileMode === 'workspace') {
      profile = await persistentProfileDirectory(state, workspaceId, workspaceRoot);
      if (state.persistentProfileOwners.has(profile.key)) throw new Error('A live or starting Browser Control session already owns this workspace persistent profile');
      profileReservation = `starting-${crypto.randomUUID()}`;
      state.persistentProfileOwners.set(profile.key, profileReservation);
      resource.profile = { key: profile.key, owner: profileReservation };
      if (typeof api.chromium.launchPersistentContext !== 'function') throw new Error('Configured Playwright runtime does not support persistent Chromium contexts');
      context = resource.context = await api.chromium.launchPersistentContext(profile.directory, { ...launchOptions, ...contextOptions });
      browser = resource.browser = typeof context.browser === 'function' ? context.browser() : null;
    } else {
      browser = resource.browser = await api.chromium.launch(launchOptions);
      context = resource.context = await browser.newContext(contextOptions);
    }
    if (state.closing) throw new Error('Browser Control engine stopped during startup');
    if (!allowRemoteUrls) {
      await context.route('**/*', async route => requestUrlAllowed(route.request().url(), false) ? route.continue() : route.abort('blockedbyclient'));
      if (typeof context.routeWebSocket !== 'function') {
        throw new Error('Browser Control loopback-only mode requires Playwright 1.48 or newer for WebSocket routing');
      }
      await context.routeWebSocket('**/*', async webSocket => {
        if (webSocketUrlAllowed(webSocket.url(), false)) {
          webSocket.connectToServer();
          return;
        }
        await webSocket.close({ code: 1008, reason: 'Blocked by DevMate Browser Control' });
      });
    }
    const id = `browser-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    session = {
      id, workspaceId, workspaceRoot, browser, context, modulePath, headless: resolvedHeadless, allowRemoteUrls,
      profileMode: resolvedProfileMode, profileKey: profile?.key || null, profileReleased: false,
      controlMode: 'agent', closed: false, cleanedUp: false,
      createdAt: now, lastUsedAt: now, activeTabId: null, nextTabId: 1, pages: new Map(), pageIds: new WeakMap()
    };
    session.resource = resource;
    resource.session = session;
    state.sessions.set(id, session);
    if (session.profileKey) { state.persistentProfileOwners.set(session.profileKey, id); resource.profile.owner = id; }
    context.on?.('page', page => { try { registerBrowserPage(session, page); } catch {} });
    const observedClosure = () => {
      session.closed = true;
      queueMicrotask(() => { void closeBrowserResource(state, resource).catch(error => { session.closeError = error.message; }); });
    };
    context.once?.('close', observedClosure);
    browser?.once?.('disconnected', observedClosure);
    const existingPages = typeof context.pages === 'function' ? context.pages() : [];
    let page = existingPages[0] || null;
    for (const existing of existingPages) registerBrowserPage(session, existing);
    if (!page) page = await context.newPage();
    const metadata = registerBrowserPage(session, page);
    session.activeTabId = metadata.id;
    if (targetUrl) await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { session: await browserSessionSummary(session), modulePath };
  } catch (error) {
    try { await closeBrowserResource(state, resource); }
    catch (closeError) { throw new AggregateError([error, closeError], 'Browser startup failed and owned cleanup was not confirmed.'); }
    throw error;
  } finally {
    state.pendingSessionStarts = Math.max(0, state.pendingSessionStarts - 1);
    state.pendingStarts.delete(completion); finishStart();
  }
}

async function closeBrowserResource(state, resource) {
  if (resource.closing) return resource.closing;
  resource.closing = (async () => {
    const errors = [];
    try { if (resource.context) await resource.context.close(); } catch (error) { errors.push(error); }
    try { if (resource.browser?.close) await resource.browser.close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Owned browser closure was not confirmed.');
    if (resource.session) cleanupSession(state, resource.session);
    else if (resource.profile && state.persistentProfileOwners.get(resource.profile.key) === resource.profile.owner) state.persistentProfileOwners.delete(resource.profile.key);
    state.resources.delete(resource);
  })();
  try { await resource.closing; } finally { resource.closing = null; }
}

export async function stopBrowserControl(state, { workspaceId, sessionId }) {
  const session = state.sessions.get(String(sessionId || '').trim());
  if (!session || (workspaceId && session.workspaceId !== workspaceId)) throw new Error('Unknown browser control session in this workspace');
  await closeBrowserResource(state, session.resource);
  return { stopped: true, id: session.id, workspaceId: session.workspaceId, profileMode: session.profileMode };
}

export async function shutdownBrowserControl(state) {
  state.closing = true;
  await Promise.allSettled([...state.pendingStarts]);
  const results = await Promise.allSettled([...state.resources].map(resource => closeBrowserResource(state, resource)));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Some owned browser processes could not be closed.');
}

export async function listBrowserTabs(state, { workspaceId, sessionId }) {
  return browserSessionSummary(getBrowserSession(state, sessionId, workspaceId));
}

export function invalidateBrowserSnapshot(metadata) {
  metadata.snapshotId = null;
  metadata.refs.clear();
}

export function invalidateAllBrowserSnapshots(session) {
  for (const metadata of session.pages.values()) invalidateBrowserSnapshot(metadata);
}

export function assertBrowserAgentControl(session) {
  if (session.controlMode === 'human') throw new Error('Browser Control is paused for human takeover; call browser-control.resume before model-driven actions');
}

export async function takeoverBrowserControl(state, { workspaceId, sessionId }) {
  const session = getBrowserSession(state, sessionId, workspaceId);
  if (session.headless) throw new Error('Human takeover requires a visible Browser Control session');
  session.controlMode = 'human';
  invalidateAllBrowserSnapshots(session);
  session.lastUsedAt = new Date().toISOString();
  return { session: await browserSessionSummary(session), freshSnapshotRequired: true };
}

export async function resumeBrowserControl(state, { workspaceId, sessionId }) {
  const session = getBrowserSession(state, sessionId, workspaceId);
  session.controlMode = 'agent';
  invalidateAllBrowserSnapshots(session);
  session.lastUsedAt = new Date().toISOString();
  return { session: await browserSessionSummary(session), freshSnapshotRequired: true };
}

function locatorFrom(metadata, { ref, snapshotId, selector, role, name, text, exact }, label) {
  const page = metadata.page;
  if (ref) {
    if (!snapshotId || snapshotId !== metadata.snapshotId) throw new Error(`${label} element ref is stale or missing snapshotId; take a new browser-control.snapshot and use its snapshotId`);
    const resolved = metadata.refs.get(String(ref));
    if (!resolved) throw new Error(`Unknown ${label.toLowerCase()} element ref: ${ref}`);
    return page.locator(resolved);
  }
  if (selector) return page.locator(String(selector));
  if (role) return page.getByRole(String(role), { ...(name != null ? { name: String(name) } : {}), exact: !!exact });
  if (text) return page.getByText(String(text), { exact: !!exact });
  return null;
}

export function resolveBrowserLocator(metadata, action) {
  return locatorFrom(metadata, {
    ref: action.ref,
    snapshotId: action.snapshotId,
    selector: action.selector,
    role: action.role,
    name: action.name,
    text: action.targetText,
    exact: action.exact
  }, 'Browser');
}

export function resolveBrowserTargetLocator(metadata, action) {
  return locatorFrom(metadata, {
    ref: action.targetRef,
    snapshotId: action.targetSnapshotId || action.snapshotId,
    selector: action.targetSelector,
    role: action.targetRole,
    name: action.targetName,
    text: action.targetTargetText,
    exact: action.targetExact
  }, 'Target');
}

export function browserActionTimeout(action) {
  return Math.min(30000, Math.max(100, Number(action.timeoutMs) || 10000));
}

export async function browserNavigate(page, rawUrl, allowRemoteUrls, timeoutMs) {
  const target = assertAllowedUrl(rawUrl, allowRemoteUrls);
  const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  return { url: page.url(), status: response?.status?.() ?? null };
}

export const __test = {
  MAX_SESSIONS,
  MAX_TABS_PER_SESSION,
  assertAllowedUrl,
  browserExecutableAllowed,
  requestUrlAllowed,
  resolveModuleFromWorkspace,
  resolveContainedWorkspacePath,
  webSocketUrlAllowed,
  profileKey
};
