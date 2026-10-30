// What the browser can do for DevMate, as named methods. Each takes plain data and returns plain data; the bridge
// carries them between the runtime and this extension. Nothing here knows about the runtime or the wire.
//
// A method that only reads is listed in READ_ONLY: the runtime offers those to a model as reads and the rest as
// changes. Text that comes from a web page is marked untrusted: it is data, never an instruction.

import { DEBUG_READ_ONLY, createDebugger } from './debug.js';

export const READ_ONLY = Object.freeze(['browser.info', 'bookmarks.tree', 'bookmarks.search', 'tabs.list', 'windows.list', 'tabGroups.list',
  'history.search', 'downloads.list', 'sessions.recentlyClosed', 'readingList.list', 'topSites.list', 'page.read', 'page.screenshot', ...DEBUG_READ_ONLY]);
// What a step of page.run may be: the methods of one tab's page, without its picture, its stored values or the debugger itself.
// A run has RUN_MS for all its steps, as long as the runtime waits for it.
const RUN_MS = 5 * 60 * 1000;
export const RUN_STEPS = Object.freeze(['tabs.navigate', 'tabs.back', 'tabs.forward', 'page.read', 'page.snapshot', 'page.inspect', 'page.waitFor', 'page.console', 'page.network',
  'page.click', 'page.hover', 'page.type', 'page.press', 'page.select', 'page.scroll', 'page.evaluate', 'page.dialog', 'page.reload', 'page.tools', 'page.callTool']);

const fail = (code, message) => Object.assign(new Error(message), { code });
const text = (value, name, { optional = false, max = 4096 } = {}) => {
  if (value === undefined || value === null) { if (optional) return undefined; throw fail('invalid_input', name + ' is required.'); }
  if (typeof value !== 'string' || value.length > max) throw fail('invalid_input', name + ' must be text of at most ' + max + ' characters.');
  return value;
};
const whole = (value, name, { optional = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined || value === null) { if (optional) return undefined; throw fail('invalid_input', name + ' is required.'); }
  if (!Number.isInteger(value) || value < min || value > max) throw fail('invalid_input', name + ' must be a whole number from ' + min + ' to ' + max + '.');
  return value;
};
const count = (value, fallback, max) => Math.min(max, whole(value, 'limit', { optional: true, min: 1 }) ?? fallback);
// Pages a model may open or go to. Anything else (javascript:, file:, the browser's own pages) is refused.
const webAddress = (value, name = 'url') => {
  const address = text(value, name);
  if (!/^https?:\/\//i.test(address)) throw fail('invalid_input', name + ' must start with http:// or https://.');
  return address;
};
const ids = (value, name) => {
  const list = Array.isArray(value) ? value : [value];
  if (!list.length || list.length > 500) throw fail('invalid_input', name + ' must name 1 to 500 tabs.');
  return list.map(item => whole(item, name));
};

const bookmark = (node, depth) => ({ id: node.id, title: node.title, ...(node.url ? { url: node.url } : {}), ...(node.parentId ? { parentId: node.parentId } : {}), index: node.index,
  ...(node.dateAdded ? { addedAt: new Date(node.dateAdded).toISOString() } : {}),
  ...(node.children ? (depth > 0 ? { children: node.children.map(child => bookmark(child, depth - 1)) } : { folder: true, childCount: node.children.length }) : {}) });
const tab = item => ({ id: item.id, windowId: item.windowId, index: item.index, title: item.title || '', url: item.url || item.pendingUrl || '', active: item.active === true,
  pinned: item.pinned === true, ...(item.audible ? { audible: true } : {}), ...(item.groupId >= 0 ? { groupId: item.groupId } : {}), status: item.status });
const windowOf = item => ({ id: item.id, focused: item.focused === true, state: item.state, type: item.type, ...(item.incognito ? { incognito: true } : {}) });
const group = item => ({ id: item.id, windowId: item.windowId, title: item.title || '', color: item.color, collapsed: item.collapsed === true });
const download = item => ({ id: item.id, url: item.finalUrl || item.url, file: item.filename, state: item.state, bytes: item.bytesReceived, ...(item.totalBytes > 0 ? { totalBytes: item.totalBytes } : {}),
  startedAt: item.startTime, ...(item.endTime ? { endedAt: item.endTime } : {}), ...(item.error ? { error: item.error } : {}) });

/**
 * The methods, bound to a chrome object (the real one in the extension, a stand-in in tests). What else is given
 * (onChange, the clock and the timers) goes to the debugger: see createDebugger.
 */
// paused: whether the owner has paused DevMate's use of the browser (the bridge refuses a call then; a run asks before
// each of its steps).
export function createCapabilities(chrome, { version = '', ownPort = () => undefined, paused = async () => false, ...debugging } = {}) {
  const available = (api, name) => { if (!api) throw fail('not_supported', 'This browser has no ' + name + ' for extensions.'); return api; };
  // DevMate's own workbench is not read, worked or sent elsewhere through the browser. What is decided there (what an
  // agent asks for, whether a task is handed to a coding agent, the access profile) is the owner's to decide at the
  // computer, and a client that could click in that tab would be deciding it for them. The tab is known by the local
  // port DevMate says it answers the owner on (ownPort) and, where the runtime did not say or the page is reached
  // through another port, by the name the page gives itself. A tab on its way there counts as there.
  // A page of this extension opened as a tab is kept from it for the same reason: a script run there (the browser lets
  // an extension debug its own pages, seen in a real Chrome) has everything the extension has, the workbench tab included.
  const own = tab => {
    for (const address of [tab?.url, tab?.pendingUrl]) {
      try {
        const at = new URL(address);
        if (at.protocol === 'chrome-extension:' && at.host === chrome.runtime?.id) return 'This tab is a page of the DevMate extension itself. It is not read or worked through the browser.';
        if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(at.hostname) && (Number(at.port) === ownPort() || tab.title === 'DevMate Workbench'))
          return 'This tab is DevMate\'s own workbench, where the owner decides at the computer. It is not read, worked or sent elsewhere through the browser.';
      } catch { /* not an address: nothing of DevMate's */ }
    }
    return '';
  };
  // The tab a page method works on: the one named, or the one in front.
  async function target(tabId) {
    const tab = tabId !== undefined && tabId !== null ? await chrome.tabs.get(whole(tabId, 'tabId')).catch(() => { throw fail('not_found', 'No tab has the id ' + tabId + '.'); })
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab) throw fail('not_found', 'No tab is open.');
    const kept = own(tab);
    if (kept) throw fail('not_supported', kept);
    return tab;
  }
  const debug = createDebugger(chrome, { target, ...debugging });
  // A tab that is being debugged and goes to one of these is let go as soon as the browser says where it is going.
  chrome.tabs?.onUpdated?.addListener?.((tabId, change, tab) => { if (own(tab)) void debug.release(tabId); });
  const methods = {
    'browser.info': async () => ({ extension: version, browser: globalThis.navigator?.userAgentData?.brands?.map(item => item.brand + ' ' + item.version).join(', ') || globalThis.navigator?.userAgent || '',
      methods: Object.keys(methods), readOnly: READ_ONLY }),

    'bookmarks.tree': async ({ folderId, depth } = {}) => {
      const levels = whole(depth, 'depth', { optional: true, min: 1, max: 32 }) ?? 2;
      const roots = folderId === undefined ? await chrome.bookmarks.getTree() : await chrome.bookmarks.getSubTree(text(folderId, 'folderId', { max: 64 })).catch(() => { throw fail('not_found', 'No bookmark folder has the id ' + folderId + '.'); });
      return { items: roots.flatMap(root => folderId === undefined ? (root.children || []) : [root]).map(node => bookmark(node, levels - 1)) };
    },
    'bookmarks.search': async ({ query, limit } = {}) => {
      const found = await chrome.bookmarks.search(text(query, 'query', { max: 1000 })), most = count(limit, 50, 500);
      return { items: found.slice(0, most).map(node => bookmark(node, 0)), total: found.length, ...(found.length > most ? { truncated: true } : {}) };
    },
    'bookmarks.create': async ({ parentId, title, url, index } = {}) => bookmark(await chrome.bookmarks.create({ ...(parentId !== undefined ? { parentId: text(parentId, 'parentId', { max: 64 }) } : {}),
      title: text(title, 'title', { max: 1000 }), ...(url !== undefined ? { url: webAddress(url) } : {}), ...(index !== undefined ? { index: whole(index, 'index') } : {}) }), 0),
    'bookmarks.update': async ({ id, title, url } = {}) => {
      if (title === undefined && url === undefined) throw fail('invalid_input', 'Give a new title, a new url, or both.');
      return bookmark(await chrome.bookmarks.update(text(id, 'id', { max: 64 }), { ...(title !== undefined ? { title: text(title, 'title', { max: 1000 }) } : {}), ...(url !== undefined ? { url: webAddress(url) } : {}) })
        .catch(() => { throw fail('not_found', 'No bookmark has the id ' + id + '.'); }), 0);
    },
    'bookmarks.move': async ({ id, parentId, index } = {}) => {
      if (parentId === undefined && index === undefined) throw fail('invalid_input', 'Give the folder to move to (parentId), the position (index), or both.');
      return bookmark(await chrome.bookmarks.move(text(id, 'id', { max: 64 }), { ...(parentId !== undefined ? { parentId: text(parentId, 'parentId', { max: 64 }) } : {}), ...(index !== undefined ? { index: whole(index, 'index') } : {}) })
        .catch(() => { throw fail('not_found', 'The bookmark or the folder to move it to does not exist.'); }), 0);
    },
    'bookmarks.remove': async ({ id, recursive } = {}) => {
      const key = text(id, 'id', { max: 64 });
      // A folder with content goes only when that was asked for.
      await (recursive === true ? chrome.bookmarks.removeTree(key) : chrome.bookmarks.remove(key)).catch(error => {
        throw /empty/i.test(String(error?.message)) ? fail('invalid_input', 'This folder is not empty. Pass recursive:true to remove it with everything in it.') : fail('not_found', 'No bookmark has the id ' + id + '.');
      });
      return { removed: key };
    },

    'tabs.list': async ({ windowId, query } = {}) => {
      const all = await chrome.tabs.query(windowId === undefined ? {} : { windowId: whole(windowId, 'windowId') }), wanted = text(query, 'query', { optional: true, max: 1000 })?.toLowerCase();
      return { items: all.map(tab).filter(item => !wanted || item.title.toLowerCase().includes(wanted) || item.url.toLowerCase().includes(wanted)) };
    },
    'tabs.open': async ({ url, active, windowId } = {}) => tab(await chrome.tabs.create({ url: webAddress(url), active: active !== false, ...(windowId !== undefined ? { windowId: whole(windowId, 'windowId') } : {}) })),
    'tabs.activate': async ({ tabId } = {}) => {
      const shown = await chrome.tabs.update(whole(tabId, 'tabId'), { active: true }).catch(() => { throw fail('not_found', 'No tab has the id ' + tabId + '.'); });
      await chrome.windows.update(shown.windowId, { focused: true });
      return tab(shown);
    },
    // The workbench tab is not sent elsewhere either: what its tab was signed in with stays behind in the tab.
    'tabs.navigate': async ({ tabId, url } = {}) => {
      const id = whole(tabId, 'tabId'), address = webAddress(url);
      await target(id);
      return tab(await chrome.tabs.update(id, { url: address }).catch(() => { throw fail('not_found', 'No tab has the id ' + tabId + '.'); }));
    },
    'tabs.reload': async ({ tabId } = {}) => { await chrome.tabs.reload(whole(tabId, 'tabId')).catch(() => { throw fail('not_found', 'No tab has the id ' + tabId + '.'); }); return { reloaded: tabId }; },
    // Back and forward in a tab's own history. A tab with nowhere to go says so. The page is still on its way when
    // this answers, so the address is not given: it would be the one that is being left.
    'tabs.back': async ({ tabId } = {}) => { const page = await target(tabId); await chrome.tabs.goBack(page.id).catch(() => { throw fail('invalid_input', 'This tab has no page to go back to.'); }); return { tabId: page.id, went: 'back' }; },
    'tabs.forward': async ({ tabId } = {}) => { const page = await target(tabId); await chrome.tabs.goForward(page.id).catch(() => { throw fail('invalid_input', 'This tab has no page to go forward to.'); }); return { tabId: page.id, went: 'forward' }; },
    'tabs.close': async ({ tabIds } = {}) => { const list = ids(tabIds, 'tabIds'); await chrome.tabs.remove(list).catch(() => { throw fail('not_found', 'One of these tabs does not exist: ' + list.join(', ') + '.'); }); return { closed: list }; },
    'tabs.move': async ({ tabId, index, windowId } = {}) => tab(await chrome.tabs.move(whole(tabId, 'tabId'), { index: whole(index, 'index', { min: -1 }), ...(windowId !== undefined ? { windowId: whole(windowId, 'windowId') } : {}) })
      .catch(() => { throw fail('not_found', 'The tab or the window to move it to does not exist.'); })),
    'tabs.group': async ({ tabIds, groupId, title, color } = {}) => {
      // All of the input is checked before the browser is asked: a refused call must not have grouped anything.
      const look = { ...(title !== undefined ? { title: text(title, 'title', { max: 200 }) } : {}), ...(color !== undefined ? { color: text(color, 'color', { max: 20 }) } : {}) };
      const joined = await chrome.tabs.group({ tabIds: ids(tabIds, 'tabIds'), ...(groupId !== undefined ? { groupId: whole(groupId, 'groupId') } : {}) }).catch(() => { throw fail('not_found', 'One of these tabs, or the group, does not exist.'); });
      return group(Object.keys(look).length ? await chrome.tabGroups.update(joined, look) : await chrome.tabGroups.get(joined));
    },
    'tabs.ungroup': async ({ tabIds } = {}) => { const list = ids(tabIds, 'tabIds'); await chrome.tabs.ungroup(list).catch(() => { throw fail('not_found', 'One of these tabs does not exist.'); }); return { ungrouped: list }; },
    'tabGroups.list': async () => ({ items: (await chrome.tabGroups.query({})).map(group) }),

    'windows.list': async () => ({ items: (await chrome.windows.getAll({})).map(windowOf) }),
    'windows.create': async ({ url } = {}) => windowOf(await chrome.windows.create(url === undefined ? {} : { url: webAddress(url) })),
    'windows.close': async ({ windowId } = {}) => { await chrome.windows.remove(whole(windowId, 'windowId')).catch(() => { throw fail('not_found', 'No window has the id ' + windowId + '.'); }); return { closed: windowId }; },

    'history.search': async ({ query, startTime, endTime, limit } = {}) => {
      const from = startTime === undefined ? 0 : Date.parse(text(startTime, 'startTime', { max: 40 })), to = endTime === undefined ? undefined : Date.parse(text(endTime, 'endTime', { max: 40 }));
      if (Number.isNaN(from) || Number.isNaN(to)) throw fail('invalid_input', 'startTime and endTime are dates such as 2026-10-11 or 2026-10-11T09:00:00Z.');
      const found = await chrome.history.search({ text: text(query, 'query', { optional: true, max: 1000 }) || '', startTime: from, ...(to !== undefined ? { endTime: to } : {}), maxResults: count(limit, 50, 1000) });
      return { items: found.map(item => ({ url: item.url, title: item.title || '', visits: item.visitCount, lastVisitAt: item.lastVisitTime ? new Date(item.lastVisitTime).toISOString() : null })) };
    },
    'history.delete': async ({ url, startTime, endTime } = {}) => {
      if (url !== undefined) { await chrome.history.deleteUrl({ url: text(url, 'url') }); return { deleted: url }; }
      const from = Date.parse(text(startTime, 'startTime', { max: 40 })), to = Date.parse(text(endTime, 'endTime', { max: 40 }));
      if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw fail('invalid_input', 'Give one url, or a startTime and a later endTime as dates.');
      await chrome.history.deleteRange({ startTime: from, endTime: to });
      return { deleted: { startTime, endTime } };
    },

    'downloads.list': async ({ query, limit } = {}) => {
      const words = text(query, 'query', { optional: true, max: 1000 });
      return { items: (await chrome.downloads.search({ ...(words ? { query: [words] } : {}), limit: count(limit, 50, 500), orderBy: ['-startTime'] })).map(download) };
    },
    'downloads.start': async ({ url, filename } = {}) => ({ id: await chrome.downloads.download({ url: webAddress(url), ...(filename !== undefined ? { filename: text(filename, 'filename', { max: 512 }) } : {}) }) }),

    'sessions.recentlyClosed': async ({ limit } = {}) => ({ items: (await chrome.sessions.getRecentlyClosed({ maxResults: count(limit, 10, 25) })).map(item => item.tab
      ? { sessionId: item.tab.sessionId, kind: 'tab', title: item.tab.title || '', url: item.tab.url || '' }
      : { sessionId: item.window?.sessionId, kind: 'window', tabs: (item.window?.tabs || []).map(inner => ({ title: inner.title || '', url: inner.url || '' })) }) }),
    'sessions.restore': async ({ sessionId } = {}) => {
      const back = await chrome.sessions.restore(sessionId === undefined ? undefined : text(sessionId, 'sessionId', { max: 64 })).catch(() => { throw fail('not_found', 'Nothing closed recently has the id ' + sessionId + '.'); });
      return back.tab ? { restored: 'tab', tab: tab(back.tab) } : { restored: 'window', windowId: back.window?.id };
    },

    'readingList.list': async () => ({ items: (await available(chrome.readingList, 'reading list').query({})).map(item => ({ url: item.url, title: item.title, read: item.hasBeenRead === true })) }),
    'readingList.add': async ({ url, title } = {}) => { await available(chrome.readingList, 'reading list').addEntry({ url: webAddress(url), title: text(title, 'title', { max: 1000 }), hasBeenRead: false }); return { added: url }; },
    'readingList.remove': async ({ url } = {}) => { await available(chrome.readingList, 'reading list').removeEntry({ url: text(url, 'url') }).catch(() => { throw fail('not_found', 'The reading list has no entry for ' + url + '.'); }); return { removed: url }; },

    'topSites.list': async () => ({ items: await chrome.topSites.get() }),

    'page.read': async ({ tabId, maxChars } = {}) => {
      const page = await target(tabId), most = Math.min(200000, whole(maxChars, 'maxChars', { optional: true, min: 100 }) ?? 20000);
      const [frame] = await chrome.scripting.executeScript({ target: { tabId: page.id }, func: () => ({ title: document.title, url: location.href, text: document.body ? document.body.innerText : '' }) })
        .catch(error => { throw fail('browser_error', 'The browser does not let an extension read this page (' + String(error?.message || error).slice(0, 200) + ').'); });
      const read = frame?.result || { title: page.title || '', url: page.url || '', text: '' };
      return { tabId: page.id, title: read.title, url: read.url, text: read.text.slice(0, most), ...(read.text.length > most ? { truncated: true, totalChars: read.text.length } : {}), untrusted: true };
    },
    'page.screenshot': async ({ tabId, fullPage, ref, selector, text: words } = {}) => {
      // One element (by ref, selector or the text it shows) is pictured through the debugger, wherever the tab is.
      const part = ref !== undefined || selector !== undefined || words !== undefined ? { ref, selector, text: words } : null;
      if (part && fullPage === true) throw fail('invalid_input', 'A picture is of the whole page (fullPage) or of one element (ref, selector or text), not both.');
      const page = await target(tabId);
      if (part) return debug.capture(page.id, { part });
      // The tab in front is captured as it is seen. The whole page, a tab behind another, and a tab in front of a
      // window that is itself put away (the page says so; one that cannot be asked is taken as shown) take the debugger.
      // A page that does not answer within a moment (it is still loading, busy, or showing a dialog) is not waited for:
      // it is captured as it is seen, as every tab in front was before.
      const later = debugging.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
      const shown = () => {
        const asked = chrome.scripting?.executeScript({ target: { tabId: page.id }, injectImmediately: true, func: () => document.visibilityState }).then(([frame]) => frame?.result !== 'hidden', () => true);
        return asked === undefined || Promise.race([asked, later(400).then(() => true)]);
      };
      const seen = fullPage !== true && page.active && await shown();
      if (!seen) return debug.capture(page.id, { fullPage: fullPage === true });
      // Under a dialog the browser was seen to give the picture at once, and also not at all: it is not waited for to the end.
      const image = await Promise.race([chrome.tabs.captureVisibleTab(page.windowId, { format: 'png' }).catch(error => { throw fail('browser_error', 'The browser did not capture this tab (' + String(error?.message || error).slice(0, 200) + ').'); }),
        later(8000).then(() => { throw fail('browser_error', 'The browser gave no picture of this tab in eight seconds. A page that is showing a dialog may be why: answer it with page.dialog, or, where the tab does not answer that either, close the dialog in the browser or load the page again (tabs.reload).'); })]);
      return { tabId: page.id, mimeType: 'image/png', base64: image.slice(image.indexOf(',') + 1) };
    },
    ...debug.methods
  };
  // Several methods of a page one after another on one tab, as one call: what a model would otherwise ask for one at
  // a time, waiting for each answer. Each step is that method itself, checked as when it is called alone. The run
  // stops at the first step that fails, and says which one, and how many were not done. It stops as well before a step
  // once the owner has paused DevMate's use of the browser, once the debugger was taken off the tab while it ran (the
  // owner took it off, or the tab went), and once its time is up: the runtime waits for a run no longer than that.
  methods['page.run'] = async ({ tabId, steps } = {}) => {
    if (!Array.isArray(steps) || !steps.length || steps.length > 30) throw fail('invalid_input', 'steps is a list of 1 to 30 steps, each { method, input }.');
    for (const [at, step] of steps.entries()) {
      if (!step || typeof step !== 'object' || Array.isArray(step) || !RUN_STEPS.includes(step.method)) throw fail('invalid_input', 'Step ' + (at + 1) + ': method is one of ' + RUN_STEPS.join(', ') + '.');
      if (step.input !== undefined && (step.input === null || typeof step.input !== 'object' || Array.isArray(step.input))) throw fail('invalid_input', 'Step ' + (at + 1) + ': input is an object.');
      if (step.input?.tabId !== undefined && step.input.tabId !== null) throw fail('invalid_input', 'Step ' + (at + 1) + ': a run works on one tab. Give its tabId once, for the run.');
    }
    const page = await target(tabId), done = [], began = (debugging.clock || Date.now)();
    // watched: the tab had the debugger on it at some time during the run, so that its going is the owner taking it off.
    let watched = debug.debugging().includes(page.id);
    for (const [at, step] of steps.entries()) {
      const stop = at > 0 && await paused() ? { code: 'paused', message: 'The owner paused DevMate\'s use of this browser while the run went on: this step and those after it were not done.' }
        : watched && !debug.debugging().includes(page.id) ? { code: 'browser_error', message: 'The debugger was taken off this tab while the run went on: the owner took it off, or the tab was closed. This step and those after it were not done.' }
        : (debugging.clock || Date.now)() - began > RUN_MS ? { code: 'timeout', message: 'The run took longer than its ' + RUN_MS / 60000 + ' minutes: this step and those after it were not done.' } : null;
      done.push({ method: step.method, ...(stop ? { ok: false, error: stop } : await answer(methods, step.method, { ...step.input, tabId: page.id })) });
      watched ||= debug.debugging().includes(page.id);
      if (!done.at(-1).ok) return { tabId: page.id, steps: done, failed: at + 1, notDone: steps.length - at - 1, untrusted: true };
    }
    return { tabId: page.id, steps: done, untrusted: true };
  };
  return methods;
}

/** One call from the runtime, answered in the shape the wire carries: a result, or an error with a code. */
export async function answer(methods, method, params) {
  const run = Object.hasOwn(methods, method) ? methods[method] : null;
  if (!run) return { ok: false, error: { code: 'not_supported', message: 'This extension has no method ' + String(method).slice(0, 80) + '.' } };
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return { ok: false, error: { code: 'invalid_input', message: 'The input of ' + method + ' is an object.' } };
  // A model often writes null for what it leaves out: that is the same as leaving it out.
  try { return { ok: true, result: await run(Object.fromEntries(Object.entries(params || {}).filter(([, value]) => value !== null))) }; }
  catch (error) { return { ok: false, error: { code: error?.code || 'browser_error', message: String(error?.message || error).slice(0, 500) } }; }
}
