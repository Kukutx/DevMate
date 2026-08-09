import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function safeWorkspaceOutput(workspaceRoot, relativePath, label) {
  const value = String(relativePath || '').trim();
  if (!value) return null;
  const target = path.resolve(workspaceRoot, value);
  if (!isInside(workspaceRoot, target)) throw new Error(`${label} path escapes workspace root`);
  return target;
}

function assertAllowedUrl(rawUrl, allowRemoteUrls) {
  const url = new URL(String(rawUrl || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported browser URL protocol: ${url.protocol}`);
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (!local && !allowRemoteUrls) throw new Error('Remote browser URLs are disabled. Use a DevMate local preview or explicitly enable allowRemoteUrls.');
  return url;
}

function browserExecutableAllowed(value) {
  if (!value) return true;
  const base = path.basename(String(value).replace(/\\/g, '/')).toLowerCase();
  return /^(?:google chrome|chrome|chrome-headless-shell|chromium|chromium-browser|msedge)(?:\.exe)?$/.test(base);
}

function resolveModuleFromWorkspace(workspaceRoot, configuredPath = '') {
  const root = fs.realpathSync.native(workspaceRoot);
  if (configuredPath) {
    const target = path.isAbsolute(configuredPath) ? path.resolve(configuredPath) : path.resolve(root, configuredPath);
    if (!isInside(root, target)) throw new Error('Configured Playwright module path must stay inside the workspace');
    const stat = fs.statSync(target, { throwIfNoEntry: false });
    if (!stat) throw new Error(`Configured Playwright module path not found: ${configuredPath}`);
    return target;
  }
  const requireFromWorkspace = createRequire(path.join(root, 'package.json'));
  for (const name of ['playwright', 'playwright-core']) {
    try { return requireFromWorkspace.resolve(name); } catch {}
  }
  return null;
}

export function browserQaStatus(workspaceRoot, settings = {}) {
  let modulePath = null;
  let error = null;
  try { modulePath = resolveModuleFromWorkspace(workspaceRoot, settings.playwrightModulePath || ''); }
  catch (cause) { error = cause.message; }
  const executablePath = String(settings.chromiumExecutablePath || '').trim();
  const executableAllowed = browserExecutableAllowed(executablePath);
  const executableExists = !executablePath || !!fs.statSync(executablePath, { throwIfNoEntry: false })?.isFile();
  return {
    available: !!modulePath && executableExists && executableAllowed,
    modulePath,
    moduleConfigured: !!settings.playwrightModulePath,
    chromiumExecutablePath: executablePath || null,
    chromiumExecutableExists: executableExists,
    chromiumExecutableAllowed: executableAllowed,
    allowRemoteUrls: !!settings.allowRemoteUrls,
    error: error || (!executableAllowed ? `Configured browser executable is not Chrome/Chromium/Edge: ${executablePath}` : !executableExists ? `Chromium executable not found: ${executablePath}` : null)
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

function cloneJson(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { return null; }
}

export async function readQaState(page) {
  return page.evaluate(() => {
    const raw = globalThis.__DEVMATE_QA_STATE__;
    if (raw == null) return null;
    if (typeof raw === 'string') {
      try { return JSON.parse(raw); } catch { return { _raw: raw }; }
    }
    try { return JSON.parse(JSON.stringify(raw)); } catch { return null; }
  });
}

export function stateValueAtPath(state, statePath = '') {
  const pathText = String(statePath || '').trim();
  if (!pathText) return state;
  const parts = pathText.split('.').filter(Boolean);
  let current = state;
  for (const part of parts) {
    if (['__proto__', 'prototype', 'constructor'].includes(part)) throw new Error(`Unsafe QA state path segment: ${part}`);
    if (current == null || (typeof current !== 'object' && !Array.isArray(current))) return undefined;
    current = current[part];
  }
  return current;
}

export function compareQaValue(actual, operator, expected) {
  switch (operator) {
    case 'eq': return Object.is(actual, expected);
    case 'neq': return !Object.is(actual, expected);
    case 'gt': return Number(actual) > Number(expected);
    case 'gte': return Number(actual) >= Number(expected);
    case 'lt': return Number(actual) < Number(expected);
    case 'lte': return Number(actual) <= Number(expected);
    case 'includes': return typeof actual === 'string' || Array.isArray(actual) ? actual.includes(expected) : false;
    case 'truthy': return !!actual;
    case 'falsy': return !actual;
    default: throw new Error(`Unsupported QA state operator: ${operator}`);
  }
}

async function waitForQaState(page, action) {
  const operator = action.operator || 'eq';
  const timeoutMs = Math.min(30000, Math.max(100, Number(action.timeoutMs) || 10000));
  const deadline = Date.now() + timeoutMs;
  let state = null;
  let actual;
  do {
    state = await readQaState(page);
    actual = stateValueAtPath(state, action.statePath || '');
    if (compareQaValue(actual, operator, action.value)) {
      return { state: cloneJson(state), actual: cloneJson(actual), operator, expected: cloneJson(action.value) };
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new Error(`QA state assertion failed at ${action.statePath || '(root)'}: actual=${JSON.stringify(actual)} operator=${operator} expected=${JSON.stringify(action.value)}`);
}

async function performAction(page, action, workspaceRoot) {
  const type = String(action?.type || '').trim();
  if (type === 'wait') {
    await page.waitForTimeout(Math.min(30000, Math.max(0, Number(action.ms) || 0)));
    return { type, ok: true };
  }
  if (type === 'press') {
    await page.keyboard.press(String(action.key || ''));
    return { type, key: action.key, ok: true };
  }
  if (type === 'key_down') {
    await page.keyboard.down(String(action.key || ''));
    return { type, key: action.key, ok: true };
  }
  if (type === 'key_up') {
    await page.keyboard.up(String(action.key || ''));
    return { type, key: action.key, ok: true };
  }
  if (type === 'click') {
    if (action.selector) await page.locator(String(action.selector)).click({ timeout: Math.min(30000, Number(action.timeoutMs) || 10000) });
    else await page.mouse.click(Number(action.x) || 0, Number(action.y) || 0, { button: action.button || 'left' });
    return { type, selector: action.selector || null, x: action.x ?? null, y: action.y ?? null, ok: true };
  }
  if (type === 'move') {
    await page.mouse.move(Number(action.x) || 0, Number(action.y) || 0);
    return { type, x: action.x ?? null, y: action.y ?? null, ok: true };
  }
  if (type === 'type') {
    const selector = String(action.selector || '');
    await page.locator(selector).fill(String(action.text || ''), { timeout: Math.min(30000, Number(action.timeoutMs) || 10000) });
    return { type, selector, chars: String(action.text || '').length, ok: true };
  }
  if (type === 'focus') {
    const selector = String(action.selector || '');
    await page.locator(selector).focus({ timeout: Math.min(30000, Number(action.timeoutMs) || 10000) });
    return { type, selector, ok: true };
  }
  if (type === 'expect_visible') {
    const selector = String(action.selector || '');
    await page.locator(selector).waitFor({ state: 'visible', timeout: Math.min(30000, Number(action.timeoutMs) || 10000) });
    return { type, selector, ok: true };
  }
  if (type === 'expect_text') {
    const selector = String(action.selector || 'body');
    const expected = String(action.text || '');
    const actual = String(await page.locator(selector).textContent({ timeout: Math.min(30000, Number(action.timeoutMs) || 10000) }) || '');
    if (!actual.includes(expected)) throw new Error(`Expected text not found in ${selector}: ${expected}`);
    return { type, selector, expected, ok: true };
  }
  if (type === 'capture_state') {
    const state = await readQaState(page);
    const actual = stateValueAtPath(state, action.statePath || '');
    return { type, statePath: action.statePath || '', value: cloneJson(actual), state: action.statePath ? undefined : cloneJson(state), ok: true };
  }
  if (type === 'expect_state') {
    const checked = await waitForQaState(page, action);
    return { type, statePath: action.statePath || '', ...checked, ok: true };
  }
  if (type === 'screenshot') {
    const relative = String(action.path || 'artifacts/browser/action.png');
    const target = safeWorkspaceOutput(workspaceRoot, relative, 'Screenshot');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: !!action.fullPage });
    return { type, path: relative.replace(/\\/g, '/'), ok: true };
  }
  throw new Error(`Unsupported browser action: ${type || '(empty)'}`);
}

export async function runBrowserScenario({ workspaceRoot, url, settings = {}, actions = [], screenshotPath = '', reportPath = '', timeoutMs = 60000, viewport = {} }) {
  const targetUrl = assertAllowedUrl(url, !!settings.allowRemoteUrls);
  const { api, modulePath } = await loadPlaywright(workspaceRoot, settings);
  const launchOptions = { headless: true };
  if (settings.chromiumExecutablePath) {
    if (!browserExecutableAllowed(settings.chromiumExecutablePath)) throw new Error('Configured browser executable must be Chrome, Chromium, Chrome Headless Shell, or Edge');
    launchOptions.executablePath = settings.chromiumExecutablePath;
  }
  const browser = await api.chromium.launch(launchOptions);
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const actionResults = [];
  try {
    const context = await browser.newContext({
      viewport: {
        width: Math.min(3840, Math.max(320, Number(viewport.width) || 1280)),
        height: Math.min(2160, Math.max(240, Number(viewport.height) || 720))
      }
    });
    if (!settings.allowRemoteUrls) {
      await context.route('**/*', async route => {
        const requestUrl = route.request().url();
        if (/^(?:data:|blob:|about:)/i.test(requestUrl)) { await route.continue(); return; }
        try {
          const parsed = new URL(requestUrl);
          if (['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) await route.continue();
          else await route.abort('blockedbyclient');
        } catch { await route.abort('blockedbyclient'); }
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(120000, Math.max(1000, Number(timeoutMs) || 60000)));
    page.on('console', message => consoleMessages.push({ type: message.type(), text: message.text().slice(0, 4000) }));
    page.on('pageerror', error => pageErrors.push(String(error?.stack || error?.message || error).slice(0, 8000)));
    page.on('requestfailed', request => requestFailures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText || 'failed' }));

    let response = null;
    let navigationError = null;
    let actionError = null;
    try {
      response = await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: Math.min(120000, Math.max(1000, Number(timeoutMs) || 60000)) });
    } catch (error) {
      navigationError = String(error?.stack || error?.message || error).slice(0, 8000);
    }
    if (!navigationError) {
      for (const [index, action] of actions.slice(0, 100).entries()) {
        try { actionResults.push(await performAction(page, action, workspaceRoot)); }
        catch (error) {
          actionError = { index, type: action?.type || null, message: String(error?.message || error).slice(0, 8000) };
          actionResults.push({ type: action?.type || null, ok: false, error: actionError.message });
          break;
        }
      }
    }
    await page.waitForTimeout(250).catch(() => {});
    let finalScreenshot = null;
    if (screenshotPath) {
      const target = safeWorkspaceOutput(workspaceRoot, screenshotPath, 'Screenshot');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: false });
      finalScreenshot = screenshotPath.replace(/\\/g, '/');
    }
    let pageState = null;
    try {
      pageState = await page.evaluate(() => {
        const canvases = [...document.querySelectorAll('canvas')].map((canvas, index) => {
          const rect = canvas.getBoundingClientRect();
          return { index, width: canvas.width, height: canvas.height, clientWidth: rect.width, clientHeight: rect.height, visible: rect.width > 0 && rect.height > 0 };
        });
        let qaState = null;
        const raw = globalThis.__DEVMATE_QA_STATE__;
        if (typeof raw === 'string') { try { qaState = JSON.parse(raw); } catch { qaState = { _raw: raw }; } }
        else if (raw != null) { try { qaState = JSON.parse(JSON.stringify(raw)); } catch {} }
        return {
          title: document.title,
          readyState: document.readyState,
          bodyText: String(document.body?.innerText || '').slice(0, 5000),
          canvases,
          activeElement: document.activeElement?.tagName || null,
          qaState
        };
      });
    } catch (error) {
      pageErrors.push(`Page state capture failed: ${String(error?.message || error).slice(0, 4000)}`);
    }
    const consoleErrors = consoleMessages.filter(item => item.type === 'error');
    const result = {
      ok: !!response && response.status() < 400 && !navigationError && !actionError && pageErrors.length === 0 && consoleErrors.length === 0 && requestFailures.length === 0,
      modulePath,
      url: page.url(),
      response: response ? { status: response.status(), ok: response.ok(), url: response.url() } : null,
      viewport: await page.viewportSize(),
      pageState,
      actions: actionResults,
      screenshotPath: finalScreenshot,
      reportPath: reportPath ? reportPath.replace(/\\/g, '/') : null,
      navigationError,
      actionError,
      consoleMessages,
      consoleErrors,
      pageErrors,
      requestFailures
    };
    if (reportPath) {
      const target = safeWorkspaceOutput(workspaceRoot, reportPath, 'Report');
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    }
    return result;
  } finally {
    await browser.close();
  }
}

export const __test = {
  assertAllowedUrl,
  browserExecutableAllowed,
  compareQaValue,
  isInside,
  resolveModuleFromWorkspace,
  safeWorkspaceOutput,
  stateValueAtPath
};
