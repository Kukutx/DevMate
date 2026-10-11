// A page under the debugger: what a developer looks at and does in DevTools, as methods for DevMate. The console and
// the network of a tab are recorded from the first time it is looked at; the page is read as the tree a screen reader
// sees, where every element has a number (ref) by which it is clicked, typed into or inspected; and a piece of script
// can be run in it.
//
// Chrome shows a bar while a tab is debugged. That is Chrome's rule, and the owner's way of seeing it. A tab is let go
// after five minutes without a call, at once with page.debugStop, and when the owner pauses DevMate in the panel.
// Only the page's own frame is covered: what is inside an iframe is not in the snapshot.

export const DEBUG_READ_ONLY = Object.freeze(['page.console', 'page.network', 'page.networkRequest', 'page.snapshot', 'page.inspect', 'page.storage', 'page.waitFor']);
const IDLE_MS = 5 * 60 * 1000, KEPT = 500;
// How long a picture of a tab that is not shown is waited for (see capture()). In a real Chrome one was seen to
// come after four seconds, and another never.
const HIDDEN_PICTURE_MS = 10000;
const LEVELS = { verbose: 0, debug: 0, log: 1, info: 1, navigation: 1, warning: 2, warn: 2, dialog: 2, error: 3, exception: 3, assert: 3 };
const ASKED = { debug: 0, info: 1, warn: 2, error: 3 };
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem']);
const SILENT = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation', 'RootWebArea', 'MenuListPopup']);
const STATES = ['level', 'focused', 'disabled', 'checked', 'expanded', 'selected', 'required', 'invalid'];
const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, ' '] };
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
// Headers that carry a sign-in. Their names are shown, their values are not.
const SECRET = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const STYLES = ['display', 'position', 'visibility', 'opacity', 'z-index', 'overflow', 'width', 'height', 'margin', 'padding', 'border', 'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'line-height', 'text-align', 'flex-direction', 'justify-content', 'align-items', 'gap', 'grid-template-columns', 'cursor', 'pointer-events'];
const DIALOG = Symbol('dialog');

const fail = (code, message) => Object.assign(new Error(message), { code });
const said = error => String(error?.message || error).slice(0, 300);
const cut = (value, max) => { const text = String(value ?? ''); return text.length > max ? text.slice(0, max) + '…' : text; };
const text = (value, name, { optional = false, max = 4096 } = {}) => {
  if (value === undefined) { if (optional) return undefined; throw fail('invalid_input', name + ' is required.'); }
  if (typeof value !== 'string' || !value.length || value.length > max) throw fail('invalid_input', name + ' must be text of at most ' + max + ' characters.');
  return value;
};
const whole = (value, name, { optional = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  if (value === undefined) { if (optional) return undefined; throw fail('invalid_input', name + ' is required.'); }
  if (!Number.isInteger(value) || value < min || value > max) throw fail('invalid_input', name + ' must be a whole number from ' + min + ' to ' + max + '.');
  return value;
};
const headers = given => Object.fromEntries(Object.entries(given || {}).slice(0, 80).map(([name, value]) => [name, SECRET.test(name) ? '(hidden, ' + String(value).length + ' characters)' : cut(value, 500)]));
// One thing a page printed, as the console shows it: text as it is, an object by its first properties.
const printed = item => {
  if (item.value !== undefined) return typeof item.value === 'string' ? item.value : JSON.stringify(item.value);
  if (item.subtype !== 'error' && item.preview?.properties) {
    const list = item.preview.subtype === 'array', inner = item.preview.properties.map(one => (list ? '' : one.name + ': ') + (one.type === 'string' ? JSON.stringify(one.value) : one.value)).join(', ') + (item.preview.overflow ? ', …' : '');
    return list ? '[' + inner + ']' : (item.className && item.className !== 'Object' ? item.className + ' ' : '') + '{' + inner + '}';
  }
  return item.description ?? item.unserializableValue ?? item.type;
};

// What follows runs in the page, not here: each is sent there as text, so it may use nothing else from this file.
function byText(wanted) {
  const shown = item => (item.innerText || item.value || item.getAttribute('aria-label') || '').trim();
  const hit = list => [...list].slice(0, 5000).filter(item => item.getClientRects().length && shown(item).includes(wanted)).sort((a, b) => shown(a).length - shown(b).length)[0];
  return hit(document.querySelectorAll('button, a, [role=button], [role=link], [role=tab], [role=menuitem], input, select, textarea, summary, label')) || hit(document.querySelectorAll('body *')) || null;
}
function inFront(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit || hit === this || this.contains(hit) || hit.contains(this) || hit.closest('label')?.control === this) return null;
  return '<' + hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className.trim() ? '.' + hit.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + '>';
}
function keyboard(clear) {
  const field = document.activeElement;
  if (!field || field === document.body || field === document.documentElement) return null;
  if (clear) {
    if (typeof field.select === 'function') field.select();
    else { const range = document.createRange(), chosen = getSelection(); range.selectNodeContents(field); chosen.removeAllRanges(); chosen.addRange(range); }
  }
  return field.tagName.toLowerCase() + (field.type ? '[' + field.type + ']' : '') + (field.name ? ' ' + field.name : field.id ? ' #' + field.id : '');
}
function choose(value, label) {
  if (this.tagName !== 'SELECT') return { problem: 'not a list' };
  const option = [...this.options].find(one => value !== undefined ? one.value === value : one.label.trim() === label || one.text.trim() === label);
  if (!option) return { problem: 'no such choice', choices: [...this.options].slice(0, 50).map(one => one.text.trim()) };
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: option.value, label: option.text.trim() };
}
function look(names, most) {
  const style = getComputedStyle(this), box = this.getBoundingClientRect(), html = this.outerHTML;
  const top = box.width && box.height ? document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) : null;
  return { tag: this.tagName.toLowerCase(), ...(this.id ? { id: this.id } : {}), ...(typeof this.className === 'string' && this.className ? { classes: this.className } : {}),
    box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
    ...(top && top !== this && !this.contains(top) && !top.contains(this) ? { coveredBy: '<' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + '>' } : {}),
    styles: Object.fromEntries(names.map(name => [name, style.getPropertyValue(name)])), html: html.slice(0, most), ...(html.length > most ? { htmlTruncated: true, htmlChars: html.length } : {}) };
}
function stores(withValues) {
  const read = name => {
    try {
      const store = window[name];
      return Object.keys(store).slice(0, 200).map(key => { const value = String(store.getItem(key)); return { key: key.slice(0, 200), chars: value.length, ...(withValues ? { value: value.slice(0, 2000) } : {}) }; });
    } catch { return null; }
  };
  return { origin: location.origin, localStorage: read('localStorage'), sessionStorage: read('sessionStorage') };
}
const inPage = (work, ...given) => '(' + work + ')(' + given.map(value => JSON.stringify(value)).join(', ') + ')';

/**
 * target(tabId) resolves the tab a method works on (the one named, or the one in front). The clock and the timers
 * are passed in so that tests can run without waiting. onChange tells the panel which tabs are being debugged.
 */
export function createDebugger(chrome, { target, clock = () => Date.now(), schedule = (run, ms) => setTimeout(run, ms), cancel = clearTimeout, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), onChange = () => {} } = {}) {
  const sessions = new Map(), opening = new Map();
  let listening = false;
  const raw = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
  const command = (tabId, method, params) => raw(tabId, method, params).catch(error => { throw fail('browser_error', method + ' failed: ' + said(error)); });
  const dialogOf = session => session.dialog.type + ': ' + JSON.stringify(cut(session.dialog.message, 300));

  // stamp is the time the browser gives for what happened (milliseconds), where it gives one: a line it kept from
  // before the tab was looked at is then dated when it was printed, not when it was handed over.
  function note(session, list, entry, stamp) {
    list.push({ seq: ++session.seq, at: Number.isFinite(stamp) ? Math.round(stamp) : clock(), ...entry });
    if (list.length > KEPT) { list.shift(); list.dropped++; }
  }
  function heard(source, method, params) {
    const session = sessions.get(source.tabId);
    if (!session) return;
    if (method === 'Runtime.consoleAPICalled') {
      const frame = params.stackTrace?.callFrames?.[0];
      note(session, session.console, { level: params.type === 'warning' ? 'warn' : params.type, text: cut((params.args || []).map(printed).join(' '), 2000), ...(frame?.url ? { where: cut(frame.url, 200) + ':' + (frame.lineNumber + 1) } : {}) }, params.timestamp);
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params.exceptionDetails || {};
      note(session, session.console, { level: 'exception', text: cut(details.exception?.description || details.text, 2000), ...(details.url ? { where: cut(details.url, 200) + ':' + ((details.lineNumber ?? 0) + 1) } : {}) }, params.timestamp);
    } else if (method === 'Log.entryAdded') {
      const entry = params.entry || {};
      note(session, session.console, { level: entry.level === 'warning' ? 'warn' : entry.level, text: cut(entry.text, 2000), from: entry.source, ...(entry.url ? { where: cut(entry.url, 200) + (entry.lineNumber !== undefined ? ':' + (entry.lineNumber + 1) : '') } : {}) }, entry.timestamp);
    } else if (method === 'Page.javascriptDialogOpening') {
      session.dialog = { type: params.type, message: String(params.message ?? '') };
      note(session, session.console, { level: 'dialog', text: dialogOf(session) });
      for (const wake of [...session.waiters]) wake();
    } else if (method === 'Page.javascriptDialogClosed') session.dialog = null;
    // Where one page ends and the next begins, in the list of what was printed.
    else if (method === 'Page.frameNavigated') { if (!params.frame?.parentId) note(session, session.console, { level: 'navigation', text: 'Went to ' + cut(params.frame?.url, 500) }); }
    else if (method === 'Network.requestWillBeSent') {
      note(session, session.requests, { requestId: params.requestId, method: params.request?.method, url: cut(params.request?.url, 500), type: params.type, started: params.timestamp,
        requestHeaders: headers(params.request?.headers), hasBody: params.request?.hasPostData === true });
      session.byId.set(params.requestId, session.requests.at(-1));
      if (session.byId.size > KEPT * 2) for (const key of session.byId.keys()) { if (session.byId.size <= KEPT) break; session.byId.delete(key); }
    } else if (method === 'Network.responseReceived') {
      const request = session.byId.get(params.requestId);
      if (request) Object.assign(request, { status: params.response?.status, mime: params.response?.mimeType, responseHeaders: headers(params.response?.headers), ...(params.response?.fromDiskCache ? { cached: true } : {}) });
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const request = session.byId.get(params.requestId);
      if (!request) return;
      if (request.started !== undefined && params.timestamp !== undefined) request.ms = Math.round((params.timestamp - request.started) * 1000);
      if (method === 'Network.loadingFinished') request.bytes = params.encodedDataLength;
      else request.failed = cut(params.blockedReason ? 'blocked: ' + params.blockedReason : params.canceled ? 'cancelled' : params.errorText, 200);
    }
  }
  function forget(tabId) {
    const session = sessions.get(tabId);
    if (!session) return;
    cancel(session.timer);
    sessions.delete(tabId);
    for (const wake of [...session.waiters]) wake();
    onChange([...sessions.keys()]);
  }
  async function release(tabId) {
    if (!sessions.has(tabId)) return false;
    forget(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    return true;
  }
  async function open(tabId) {
    if (!chrome.debugger) throw fail('not_supported', 'This browser gives extensions no debugger.');
    if (!listening) { chrome.debugger.onEvent.addListener(heard); chrome.debugger.onDetach.addListener(source => forget(source.tabId)); listening = true; }
    const attach = () => chrome.debugger.attach({ tabId }, '1.3');
    // A debugger this extension left on the tab before its worker was put to sleep is taken off first.
    await attach().catch(async error => { if (!/already attached/i.test(said(error))) throw error; await chrome.debugger.detach({ tabId }).catch(() => {}); return attach(); }).catch(error => {
      throw fail('browser_error', /cannot access|chrome:|chrome-extension:|web store/i.test(said(error)) ? 'The browser does not let a page of its own, or of the Web Store, be debugged.' : 'The browser did not attach the debugger to this tab (' + said(error) + ').');
    });
    // Each of the two lists counts what it lost itself, once it is full.
    const session = { tabId, seq: 0, since: clock(), console: Object.assign([], { dropped: 0 }), requests: Object.assign([], { dropped: 0 }), byId: new Map(), waiters: new Set(), dialog: null, timer: null };
    sessions.set(tabId, session);
    try { for (const domain of ['Runtime', 'Log', 'Network', 'Page']) await command(tabId, domain + '.enable'); }
    catch (error) { await release(tabId); throw error; }
    onChange([...sessions.keys()]);
    return session;
  }
  // The debugger on a tab, attached at the first call for it. started says that the watching begins only now.
  async function attached(tabId) {
    // A tab that is still being switched on is waited for, by whoever asks in the meantime too.
    let session = opening.has(tabId) ? null : sessions.get(tabId), started = false;
    if (!session) {
      if (!opening.has(tabId)) opening.set(tabId, open(tabId).finally(() => opening.delete(tabId)));
      session = await opening.get(tabId);
      started = true;
    }
    cancel(session.timer);
    session.timer = schedule(() => { void release(tabId); }, IDLE_MS);
    return { session, started };
  }
  // A page that shows alert() or confirm() answers nothing else until the dialog is answered: say so instead of waiting.
  const page = async (tabId, { whileDialog = false } = {}) => {
    const tab = await target(tabId), held = await attached(tab.id);
    if (held.session.dialog && !whileDialog) throw fail('dialog_open', 'The page is showing a dialog (' + dialogOf(held.session) + '). Nothing else works on this tab until it is answered: page.dialog with accept true or false.');
    return { tab, id: tab.id, ...held };
  };
  // Something done to the page. When the page opens a dialog in answer to it, it is not waited for any longer, and
  // what is left of it is not done (work is told by halted()). When the tab is let go in the middle, it has failed.
  function unlessDialog(session, work) {
    let wake, over = false;
    const dialog = new Promise(resolve => { wake = () => resolve(DIALOG); session.waiters.add(wake); }), doing = work(() => over);
    doing.catch(() => {});
    return Promise.race([doing, dialog]).then(result => {
      if (result === DIALOG && sessions.get(session.tabId) !== session) throw fail('browser_error', 'The debugger was taken off this tab before this was done: the owner took it off, or the tab was closed.');
      return result;
    }).finally(() => { over = true; session.waiters.delete(wake); });
  }
  const withDialog = (session, result) => session.dialog ? { ...result, dialog: dialogOf(session), note: 'The page opened a dialog and waits for it. Answer it with page.dialog.', untrusted: true } : result;
  const run = async (id, expression, { awaitPromise = false } = {}) => {
    const answer = await command(id, 'Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true, timeout: 15000 });
    if (answer.exceptionDetails) throw fail('page_error', cut(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text, 1000));
    return answer.result;
  };
  const onElement = async (id, objectId, work, ...given) => {
    const answer = await command(id, 'Runtime.callFunctionOn', { objectId, functionDeclaration: String(work), arguments: given.map(value => value === undefined ? {} : { value }), returnByValue: true, userGesture: true });
    if (answer.exceptionDetails) throw fail('page_error', cut(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text, 1000));
    return answer.result?.value;
  };

  // The element a method acts on: by its number in the last snapshot, by a CSS selector, or by the text it shows.
  async function element(id, { ref, selector, text: shown }) {
    if (ref !== undefined) {
      const found = await raw(id, 'DOM.resolveNode', { backendNodeId: whole(ref, 'ref', { min: 1 }) }).catch(() => null);
      if (!found?.object?.objectId) throw fail('not_found', 'No element has the ref ' + ref + ' any more. Take a new page.snapshot.');
      return found.object.objectId;
    }
    const expression = selector !== undefined ? 'document.querySelector(' + JSON.stringify(text(selector, 'selector', { max: 1000 })) + ')' : shown !== undefined ? inPage(byText, text(shown, 'text', { max: 500 })) : null;
    if (!expression) throw fail('invalid_input', 'Say which element: ref (its number in page.snapshot), selector, or the text it shows.');
    const answer = await command(id, 'Runtime.evaluate', { expression, returnByValue: false });
    if (answer.exceptionDetails) throw fail('invalid_input', 'The selector is not valid: ' + cut(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text, 300));
    if (!answer.result?.objectId) throw fail('not_found', 'No element on the page matches ' + (selector !== undefined ? 'the selector ' + selector : 'the text "' + shown + '"') + '.');
    return answer.result.objectId;
  }
  // Where to point at an element: the middle of it, once it is scrolled into view. Refused when something else is there.
  async function point(id, which) {
    const objectId = await element(id, which);
    await raw(id, 'DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {});
    const quad = ((await raw(id, 'DOM.getContentQuads', { objectId }).catch(() => null))?.quads || []).find(one => one.length === 8);
    if (!quad) throw fail('not_found', 'The element is not shown on the page, so it cannot be pointed at. page.inspect says how it is laid out.');
    const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4), y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4), above = await onElement(id, objectId, inFront, x, y);
    if (above) throw fail('covered', 'Another element is in front of it at that point: ' + above + '. Close or scroll away what covers it, or act on that element.');
    return { x, y };
  }
  async function press(id, name, held = []) {
    const bits = held.reduce((sum, one) => sum | MODIFIERS[one], 0), letter = /^[a-z0-9]$/i.test(name) ? name.toUpperCase() : null;
    const [code, typed] = letter ? [letter.charCodeAt(0), held.includes('shift') ? letter : name.toLowerCase()] : KEYS[name];
    const event = { key: letter ? typed : name === 'Space' ? ' ' : name, code: letter ? (/\d/.test(letter) ? 'Digit' : 'Key') + letter : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: bits };
    // With alt, ctrl or meta held it is a shortcut, not a character.
    const character = typed && !(bits & 7) ? typed : null;
    await command(id, 'Input.dispatchKeyEvent', { type: character ? 'keyDown' : 'rawKeyDown', ...event, ...(character ? { text: character } : {}) });
    await command(id, 'Input.dispatchKeyEvent', { type: 'keyUp', ...event });
  }
  const listed = (session, list, since, keep, limit) => {
    const after = whole(since, 'since', { optional: true }) ?? 0, most = Math.min(KEPT, whole(limit, 'limit', { optional: true, min: 1 }) ?? 100), items = list.filter(item => item.seq > after && keep(item));
    return { items: items.slice(-most), ...(items.length > most ? { earlierLeftOut: items.length - most } : {}), cursor: session.seq, watchingSince: new Date(session.since).toISOString(), ...(list.dropped ? { dropped: list.dropped } : {}) };
  };
  const fresh = started => started ? { note: 'The tab is watched from now on. The requests it made before are not here (page.reload shows a page loading from the start); what it printed before is, as far as the browser kept it.' } : {};
  const brief = item => ({ ...Object.fromEntries(['seq', 'requestId', 'method', 'url', 'type', 'status', 'mime', 'ms', 'bytes', 'failed', 'cached'].filter(name => item[name] !== undefined).map(name => [name, item[name]])), at: new Date(item.at).toISOString() });

  const methods = {
    'page.console': async ({ tabId, since, level, limit } = {}) => {
      if (level !== undefined && !Object.hasOwn(ASKED, level)) throw fail('invalid_input', 'level is one of: ' + Object.keys(ASKED).join(', ') + '.');
      const { id, session, started } = await page(tabId, { whileDialog: true }), view = listed(session, session.console, since, item => (LEVELS[item.level] ?? 1) >= (ASKED[level] ?? 0), limit);
      return { tabId: id, ...view, items: view.items.map(item => ({ ...item, at: new Date(item.at).toISOString() })), ...fresh(started), untrusted: true };
    },
    'page.network': async ({ tabId, since, failedOnly, query, limit } = {}) => {
      const wanted = query === '' ? undefined : text(query, 'query', { optional: true, max: 500 })?.toLowerCase(), { id, session, started } = await page(tabId, { whileDialog: true });
      const view = listed(session, session.requests, since, item => (failedOnly !== true || item.failed !== undefined || item.status >= 400) && (!wanted || item.url.toLowerCase().includes(wanted)), limit);
      return { tabId: id, ...view, items: view.items.map(brief), ...fresh(started), untrusted: true };
    },
    'page.networkRequest': async ({ tabId, requestId, maxChars } = {}) => {
      const most = Math.min(200000, whole(maxChars, 'maxChars', { optional: true, min: 100 }) ?? 20000), { id, session } = await page(tabId, { whileDialog: true }), request = session.byId.get(text(requestId, 'requestId', { max: 200 }));
      if (!request) throw fail('not_found', 'No request with this requestId was recorded on this tab. page.network lists them.');
      const result = { tabId: id, ...brief(request), requestHeaders: request.requestHeaders, ...(request.responseHeaders ? { responseHeaders: request.responseHeaders } : {}) };
      if (request.hasBody) { const sent = await raw(id, 'Network.getRequestPostData', { requestId }).catch(() => null); if (typeof sent?.postData === 'string') result.requestBody = cut(sent.postData, most); }
      const body = await raw(id, 'Network.getResponseBody', { requestId }).catch(() => null);
      if (!body) result.bodyNote = 'The browser no longer holds what came back, or nothing did. It is kept only for a while after the page loaded it.';
      else if (body.base64Encoded) result.body = { binary: true, base64Chars: body.body.length };
      else Object.assign(result, { body: body.body.slice(0, most) }, body.body.length > most ? { truncated: true, totalChars: body.body.length } : {});
      return { ...result, untrusted: true };
    },
    'page.snapshot': async ({ tabId, interactiveOnly, maxNodes } = {}) => {
      const most = Math.min(1500, whole(maxNodes, 'maxNodes', { optional: true, min: 10 }) ?? 300), { id, tab } = await page(tabId);
      await raw(id, 'Accessibility.enable').catch(() => {});
      const { nodes } = await command(id, 'Accessibility.getFullAXTree'), byId = new Map(nodes.map(node => [node.nodeId, node]));
      // The lines of a node and of what it holds.
      const walk = (node, depth, above) => {
        const role = node.role?.value || '', name = cut(node.name?.value || '', 160), value = node.value?.value, said = value !== undefined && value !== '';
        // A text that only repeats the name of what holds it says nothing new.
        const shown = !node.ignored && !SILENT.has(role) && !(role === 'StaticText' && (!name || above.includes(name))) && (interactiveOnly !== true || INTERACTIVE.has(role));
        const below = (node.childIds || []).flatMap(child => { const next = byId.get(child); return next ? walk(next, shown && interactiveOnly !== true ? depth + 1 : depth, shown && name ? name : above) : []; });
        // Something that only holds other things, and holds nothing that is shown, is left out.
        if (!shown || (!name && !said && !INTERACTIVE.has(role) && !below.length)) return below;
        const properties = node.properties || [], states = properties.filter(item => STATES.includes(item.name) && item.value?.value && item.value.value !== 'false').map(item => item.name + (item.value.value === true || item.value.value === 'true' ? '' : '=' + item.value.value));
        const address = role === 'link' ? properties.find(item => item.name === 'url')?.value?.value : undefined;
        return ['  '.repeat(Math.min(depth, 12)) + (node.backendDOMNodeId && role !== 'StaticText' ? '[' + node.backendDOMNodeId + '] ' : '') + (role === 'StaticText' ? 'text' : role) + (name ? ' "' + name + '"' : '') +
          (said ? ' value="' + cut(value, 120) + '"' : '') + (address ? ' → ' + cut(address, 200) : '') + (states.length ? ' (' + states.join(', ') + ')' : ''), ...below];
      };
      const root = nodes.find(node => !node.parentId) || nodes[0], all = root ? walk(root, 0, '') : [];
      return { tabId: id, title: tab.title || '', url: tab.url || '', text: all.slice(0, most).join('\n'), nodes: Math.min(all.length, most), ...(all.length > most ? { truncated: true, leftOut: all.length - most } : {}), untrusted: true };
    },
    'page.inspect': async ({ tabId, ref, selector, text: shown, styles, maxChars } = {}) => {
      if (styles !== undefined && (!Array.isArray(styles) || !styles.length || styles.length > 60 || styles.some(name => typeof name !== 'string' || !/^[a-z-]{1,60}$/i.test(name)))) throw fail('invalid_input', 'styles is a list of 1 to 60 CSS property names.');
      const most = Math.min(100000, whole(maxChars, 'maxChars', { optional: true, min: 100 }) ?? 4000), { id } = await page(tabId);
      return { tabId: id, ...(await onElement(id, await element(id, { ref, selector, text: shown }), look, styles || STYLES, most)), untrusted: true };
    },
    'page.storage': async ({ tabId, includeValues } = {}) => {
      const { id } = await page(tabId), kept = (await run(id, inPage(stores, includeValues === true))).value, { cookies = [] } = await command(id, 'Network.getCookies');
      return { tabId: id, ...kept, cookies: cookies.slice(0, 200).map(item => ({ name: item.name, domain: item.domain, path: item.path, ...(item.expires > 0 ? { expires: new Date(item.expires * 1000).toISOString() } : { session: true }),
        ...(item.httpOnly ? { httpOnly: true } : {}), ...(item.secure ? { secure: true } : {}), ...(item.sameSite ? { sameSite: item.sameSite } : {}), chars: item.value.length, ...(includeValues === true ? { value: cut(item.value, 2000) } : {}) })), untrusted: true };
    },
    'page.waitFor': async ({ tabId, selector, text: shown, timeoutMs } = {}) => {
      if ((selector === undefined) === (shown === undefined)) throw fail('invalid_input', 'Say what to wait for: selector, or text.');
      const limit = whole(timeoutMs, 'timeoutMs', { optional: true, min: 100, max: 30000 }) ?? 10000, began = clock();
      const expression = selector !== undefined ? '!!document.querySelector(' + JSON.stringify(text(selector, 'selector', { max: 1000 })) + ')' : '!!document.body && document.body.innerText.includes(' + JSON.stringify(text(shown, 'text', { max: 500 })) + ')';
      // The tab is the one that was in front when this was asked, whatever the owner turns to while it waits.
      const { id } = await page(tabId);
      for (;;) {
        // A page that is between two addresses has nothing to ask yet: that is a "not yet", not a failure.
        const found = await run(id, expression).then(result => result.value === true, error => { if (error.code === 'page_error' && selector !== undefined) throw fail('invalid_input', 'The selector is not valid: ' + error.message); return false; });
        if (found) return { tabId: id, found: true, ms: clock() - began };
        if (clock() - began >= limit) throw fail('timeout', (selector !== undefined ? 'Nothing matches ' + selector : 'The text "' + shown + '" is not on the page') + ' after ' + limit + ' ms.');
        await pause(250);
        // Still there, still debugged, and no dialog in the way.
        await page(id);
      }
    },

    'page.click': async ({ tabId, ref, selector, text: shown, double } = {}) => {
      const { id, session } = await page(tabId), at = await point(id, { ref, selector, text: shown }), button = { x: at.x, y: at.y, button: 'left' };
      await unlessDialog(session, async halted => {
        await command(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
        // A button that was pressed is let go whatever happens; a second click is not begun once the first was answered with a dialog.
        for (let count = 1; count <= (double === true ? 2 : 1) && !halted(); count++) {
          await command(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...button, buttons: 1, clickCount: count });
          await command(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, clickCount: count });
        }
      });
      return withDialog(session, { tabId: id, clicked: at });
    },
    'page.hover': async ({ tabId, ref, selector, text: shown } = {}) => {
      const { id } = await page(tabId), at = await point(id, { ref, selector, text: shown });
      await command(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      return { tabId: id, hovered: at };
    },
    'page.type': async ({ tabId, ref, selector, text: typed, clear } = {}) => {
      if (typeof typed !== 'string' || typed.length > 100000) throw fail('invalid_input', 'text is what to type, at most 100000 characters.');
      const { id, session } = await page(tabId);
      if (ref !== undefined || selector !== undefined) await raw(id, 'DOM.focus', { objectId: await element(id, { ref, selector }) }).catch(error => { throw error.code ? error : fail('invalid_input', 'This element cannot take the keyboard: it is not something to type into.'); });
      const into = (await run(id, inPage(keyboard, clear === true))).value;
      if (!into) throw fail('invalid_input', 'Nothing on the page has the keyboard. Say where to type: ref or selector.');
      await unlessDialog(session, async halted => {
        // Emptied the way a person empties a field: everything selected, then deleted.
        if (clear === true) await press(id, 'Delete');
        if (typed && !halted()) await command(id, 'Input.insertText', { text: typed });
      });
      return withDialog(session, { tabId: id, typed: typed.length, into, untrusted: true });
    },
    'page.press': async ({ tabId, key: name, modifiers } = {}) => {
      const held = modifiers === undefined ? [] : modifiers;
      if (!Array.isArray(held) || held.some(one => !Object.hasOwn(MODIFIERS, one))) throw fail('invalid_input', 'modifiers is a list of: ' + Object.keys(MODIFIERS).join(', ') + '.');
      if (typeof name !== 'string' || (!/^[a-z0-9]$/i.test(name) && !Object.hasOwn(KEYS, name))) throw fail('invalid_input', 'key is one letter or digit, or one of: ' + Object.keys(KEYS).join(', ') + '.');
      const { id, session } = await page(tabId);
      await unlessDialog(session, () => press(id, name, held));
      return withDialog(session, { tabId: id, pressed: [...held, name].join('+') });
    },
    'page.select': async ({ tabId, ref, selector, value, label } = {}) => {
      if ((value === undefined) === (label === undefined)) throw fail('invalid_input', 'Say which choice: value, or label (the text it shows).');
      const wanted = value !== undefined ? text(value, 'value', { max: 1000 }) : undefined, named = label !== undefined ? text(label, 'label', { max: 1000 }) : undefined, { id } = await page(tabId);
      const chosen = await onElement(id, await element(id, { ref, selector }), choose, wanted, named);
      if (chosen?.problem === 'not a list') throw fail('invalid_input', 'This element is not a <select>. A list built from other elements is opened with page.click and chosen from the same way.');
      if (chosen?.problem) throw fail('not_found', 'The list has no such choice. It offers: ' + (chosen.choices || []).join(' | '));
      return { tabId: id, selected: chosen, untrusted: true };
    },
    'page.scroll': async ({ tabId, ref, selector, deltaY } = {}) => {
      const { id } = await page(tabId);
      if (ref !== undefined || selector !== undefined) { await command(id, 'DOM.scrollIntoViewIfNeeded', { objectId: await element(id, { ref, selector }) }); return { tabId: id, scrolledTo: ref ?? selector }; }
      const by = whole(deltaY, 'deltaY', { min: -100000, max: 100000 }), view = (await command(id, 'Page.getLayoutMetrics')).cssVisualViewport || {};
      await command(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round((view.clientWidth || 800) / 2), y: Math.round((view.clientHeight || 600) / 2), deltaX: 0, deltaY: by });
      return { tabId: id, scrolledBy: by };
    },
    'page.evaluate': async ({ tabId, expression, awaitPromise } = {}) => {
      const source = text(expression, 'expression', { max: 100000 }), { id, session } = await page(tabId), result = await unlessDialog(session, () => run(id, source, { awaitPromise: awaitPromise !== false }));
      if (result === DIALOG) return withDialog(session, { tabId: id });
      const shown = String(result.value === undefined ? (result.description ?? result.unserializableValue ?? result.type) : typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 1));
      return { tabId: id, type: result.subtype || result.type, text: shown.slice(0, 20000), ...(shown.length > 20000 ? { truncated: true, totalChars: shown.length } : {}), untrusted: true };
    },
    'page.reload': async ({ tabId, ignoreCache } = {}) => { const { id } = await page(tabId); await command(id, 'Page.reload', { ignoreCache: ignoreCache === true }); return { tabId: id, reloaded: true }; },
    'page.emulate': async ({ tabId, width, height, deviceScaleFactor, mobile, userAgent, colorScheme, offline, reset } = {}) => {
      if (colorScheme !== undefined && colorScheme !== 'dark' && colorScheme !== 'light') throw fail('invalid_input', 'colorScheme is dark or light.');
      if (reset !== true && [width, height, userAgent, colorScheme, offline].every(value => value === undefined)) throw fail('invalid_input', 'Give a width and a height, a userAgent, a colorScheme, offline, or reset:true.');
      const size = width !== undefined || height !== undefined ? { width: whole(width, 'width', { min: 100, max: 8000 }), height: whole(height, 'height', { min: 100, max: 8000 }),
        deviceScaleFactor: typeof deviceScaleFactor === 'number' && deviceScaleFactor > 0 && deviceScaleFactor <= 5 ? deviceScaleFactor : 0, mobile: mobile === true } : null;
      const agent = text(userAgent, 'userAgent', { optional: true, max: 500 }), { id } = await page(tabId);
      if (reset === true) await command(id, 'Emulation.clearDeviceMetricsOverride');
      else if (size) await command(id, 'Emulation.setDeviceMetricsOverride', size);
      if (reset === true || agent !== undefined) await command(id, 'Emulation.setUserAgentOverride', { userAgent: reset === true ? '' : agent });
      if (reset === true || colorScheme !== undefined) await command(id, 'Emulation.setEmulatedMedia', { features: reset === true ? [] : [{ name: 'prefers-color-scheme', value: colorScheme }] });
      if (reset === true || offline !== undefined) await command(id, 'Network.emulateNetworkConditions', { offline: reset !== true && offline === true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      if (reset === true) return { tabId: id, reset: true };
      return { tabId: id, emulating: { ...(size ? { width, height, mobile: size.mobile } : {}), ...(agent !== undefined ? { userAgent: agent } : {}), ...(colorScheme !== undefined ? { colorScheme } : {}), ...(offline !== undefined ? { offline: offline === true } : {}) },
        note: 'It lasts while the tab is debugged: until five minutes pass without a call, or page.debugStop.' };
    },
    'page.dialog': async ({ tabId, accept, promptText } = {}) => {
      if (typeof accept !== 'boolean') throw fail('invalid_input', 'accept is true (OK) or false (Cancel).');
      const answer = text(promptText, 'promptText', { optional: true, max: 10000 }), { id, session } = await page(tabId, { whileDialog: true });
      if (!session.dialog) throw fail('not_found', 'This tab shows no dialog.');
      const answered = session.dialog;
      await command(id, 'Page.handleJavaScriptDialog', { accept, ...(answer !== undefined ? { promptText: answer } : {}) });
      session.dialog = null;
      return { tabId: id, answered: { type: answered.type, message: cut(answered.message, 1000) }, accepted: accept, untrusted: true };
    },
    'page.debugStop': async ({ tabId } = {}) => {
      if (tabId === undefined) { const all = [...sessions.keys()]; for (const id of all) await release(id); return { released: all }; }
      return { released: await release(whole(tabId, 'tabId')) ? [tabId] : [] };
    }
  };

  /** A picture of a tab through the debugger: the whole page, or a tab that is not in front. */
  async function capture(tabId, { fullPage = false } = {}) {
    const { id } = await page(tabId);
    // The browser draws only what it shows. Of a tab behind another it still has a picture where it drew it before;
    // of one that was never shown it never answers. That is waited for briefly and then said, with what to do.
    const hidden = (await run(id, 'document.visibilityState'))?.value === 'hidden';
    const pictured = params => {
      const asked = command(id, 'Page.captureScreenshot', params);
      if (!hidden) return asked;
      asked.catch(() => {});
      return Promise.race([asked, pause(HIDDEN_PICTURE_MS).then(() => { throw fail('invalid_input', 'The browser gives no picture of this tab while it is behind another: it draws only what it shows. Bring it forward (tabs.activate) and ask again.'); })]);
    };
    if (!fullPage) return { tabId: id, mimeType: 'image/png', base64: (await pictured({ format: 'png' })).data };
    // A long page is cut at a height a model can still read, and sent as JPEG so that it stays small.
    const size = (await command(id, 'Page.getLayoutMetrics')).cssContentSize || {}, width = Math.min(Math.ceil(size.width || 1280), 4096), tall = Math.ceil(size.height || 800), height = Math.min(tall, 8000);
    const shot = await pictured({ format: 'jpeg', quality: 85, clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true });
    return { tabId: id, mimeType: 'image/jpeg', base64: shot.data, fullPage: true, width, height, ...(tall > height ? { truncated: true, pageHeight: tall } : {}) };
  }

  return { methods, capture, release, debugging: () => [...sessions.keys()] };
}
