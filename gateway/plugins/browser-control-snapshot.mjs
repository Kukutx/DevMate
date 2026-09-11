import {
  DEFAULT_BODY_CHARS,
  DEFAULT_SNAPSHOT_ELEMENTS,
  MAX_BODY_CHARS,
  MAX_INLINE_SCREENSHOT_BYTES,
  MAX_SNAPSHOT_ELEMENTS,
  getBrowserPage,
  getBrowserSession
} from './browser-control-core.mjs';

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

async function inlineScreenshot(page, format, quality) {
  const type = format === 'jpeg' ? 'jpeg' : 'png';
  const options = { type, fullPage: false };
  if (type === 'jpeg') options.quality = clampInt(quality, 70, 30, 95);
  const buffer = await page.screenshot(options);
  const bytes = buffer.length;
  const mimeType = type === 'jpeg' ? 'image/jpeg' : 'image/png';
  if (bytes > MAX_INLINE_SCREENSHOT_BYTES) return { mimeType, bytes, omitted: true, reason: 'too_large' };
  return { mimeType, bytes, data: buffer.toString('base64') };
}

export async function snapshotBrowserControl({
  workspaceId,
  sessionId,
  tabId = '',
  maxElements = DEFAULT_SNAPSHOT_ELEMENTS,
  bodyChars = DEFAULT_BODY_CHARS,
  includeScreenshot = false,
  screenshotFormat = 'png',
  screenshotQuality = 70
}) {
  const session = getBrowserSession(sessionId, workspaceId);
  const metadata = getBrowserPage(session, tabId);
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
  let screenshot = null;
  if (includeScreenshot) screenshot = await inlineScreenshot(page, screenshotFormat, screenshotQuality);
  session.lastUsedAt = new Date().toISOString();
  return {
    sessionId: session.id,
    tabId: metadata.id,
    snapshotId: metadata.snapshotId,
    profileMode: session.profileMode,
    controlMode: session.controlMode,
    url: String(page.url() || '').slice(0, 4000),
    title: state.title,
    readyState: state.readyState,
    bodyText: state.bodyText,
    ariaSnapshot,
    elements: state.elements,
    frames,
    diagnostics: { console: metadata.console.slice(-30), pageErrors: metadata.pageErrors.slice(-30), requestFailures: metadata.requestFailures.slice(-30) },
    screenshot
  };
}

export const __test = { clampInt, inlineScreenshot };
