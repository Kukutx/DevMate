// A page under the debugger: what a developer looks at and does in DevTools, as methods for DevMate. The console and
// the network of a tab are recorded from the first time it is looked at; the page is read as the tree a screen reader
// sees, where every element has a number (ref) by which it is clicked, typed into or inspected; and a piece of script
// can be run in it.
//
// Chrome shows a bar while a tab is debugged. That is Chrome's rule, and the owner's way of seeing it. A tab is let go
// after five minutes without a call, at once with page.debugStop, and when the owner pauses DevMate in the panel.
// Only the page's own frame is covered: a frame inside it (an iframe) is shown in the snapshot with its address, and
// what that frame holds is not reached. What a component of the page holds (a shadow tree) is.

export const DEBUG_READ_ONLY = Object.freeze(['page.console', 'page.network', 'page.networkRequest', 'page.snapshot', 'page.inspect', 'page.storage', 'page.waitFor']);
const IDLE_MS = 5 * 60 * 1000, KEPT = 500;
// How long a tab is given to answer the first thing the debugger asks of it (see open()).
const SILENT_MS = 5000;
// How long each asking for a picture of a tab that is put away is given before it is asked for again, and at last
// given up: ten seconds in all (see capture()).
const PICTURE_AGAIN_MS = [1500, 2500, 3000, 3000];
const LEVELS = { verbose: 0, debug: 0, log: 1, info: 1, navigation: 1, warning: 2, warn: 2, dialog: 2, error: 3, exception: 3, assert: 3 };
const ASKED = { debug: 0, info: 1, warn: 2, error: 3 };
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem']);
const SILENT = new Set(['none', 'generic', 'InlineTextBox', 'LineBreak', 'presentation', 'RootWebArea', 'MenuListPopup']);
const FRAMES = new Set(['Iframe', 'IframePresentational']);
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
  // What an element is found by: the words it shows; what a field for text holds or asks for; and what it is called
  // where it shows other words or none (aria-label, aria-labelledby, title, alt). Runs of blanks count as one blank.
  // What a password field holds is never looked at, nor the value behind a choice. Of these, the length of the
  // shortest that has the text.
  const plain = name => typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '', sought = plain(wanted);
  if (!sought) return null;
  // The page itself and every component in it that shows its inside: what a component holds (a shadow tree) is not
  // among the page's own elements, and on a page built of components no text would lead to an element.
  const trees = [document];
  for (let at = 0; at < trees.length && trees.length <= 2000; at++) for (const item of trees[at].querySelectorAll('*')) if (item.shadowRoot && trees.push(item.shadowRoot) > 2000) break;
  const all = (selector, inside = selector) => trees.flatMap(tree => [...tree.querySelectorAll(tree === document ? selector : inside)]);
  const least = item => {
    const typed = item.tagName === 'TEXTAREA' || (item.tagName === 'INPUT' && !/^(password|hidden|checkbox|radio|file|range|color)$/i.test(item.type || ''));
    // An element is named by others of the tree it is in.
    const tree = item.getRootNode ? item.getRootNode() : document;
    const labelled = (item.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => tree.getElementById?.(id)?.innerText || '').join(' ');
    return Math.min(...[item.innerText, typed ? item.value : '', item.getAttribute('aria-label'), labelled, item.getAttribute('title'), item.getAttribute('alt'), item.getAttribute('placeholder')]
      .map(plain).filter(name => name.includes(sought)).map(name => name.length));
  };
  const hit = list => list.slice(0, 5000).filter(item => item.getClientRects().length).map(item => [item, least(item)]).filter(([, length]) => length < Infinity).sort((a, b) => a[1] - b[1])[0]?.[0];
  const pressed = hit(all('button, a, [role=button], [role=link], [role=tab], [role=menuitem], input, select, textarea, summary, label'));
  if (pressed) return pressed;
  // Then the innermost element that holds the words in one piece of text. It is found by the text itself, so on a
  // page of any size it is that element and not something large around it.
  let inner = null, shortest = Infinity, looked = 0;
  for (const tree of trees) {
    const top = tree === document ? document.body : tree;
    if (!top || !document.createTreeWalker) continue;
    const texts = document.createTreeWalker(top, 4);
    for (let node = texts.nextNode(); node && looked < 200000; node = texts.nextNode(), looked++) {
      if (node.data.length < sought.length) continue;
      const words = plain(node.data);
      if (!words.includes(sought) || words.length >= shortest) continue;
      // What holds it: the element it is in, or the component where it stands in a component directly; and where that
      // only passes its content on (display: contents, as a slot does), what is drawn around it, a few steps out at
      // most and never the page as a whole. A slot that was given content shows none of its own words.
      let holder = node.parentElement || node.parentNode?.host;
      for (let step = 0; holder && step < 5 && !holder.getClientRects().length && !holder.assignedNodes?.().length && typeof getComputedStyle === 'function' && getComputedStyle(holder).display === 'contents'; step++) holder = holder.parentElement || holder.parentNode?.host;
      // (What is laid out but hidden shows no words either.)
      if (holder?.getClientRects().length && holder !== document.body && holder !== document.documentElement && !(holder.tagName === 'SLOT' && holder.assignedNodes?.().length)
        && !(typeof getComputedStyle === 'function' && getComputedStyle(holder).visibility === 'hidden')) { inner = holder; shortest = words.length; }
    }
  }
  // Last, words that are spread over several elements ("Save <b>now</b>").
  return inner || hit(all('body *', '*')) || null;
}
function inFront(x, y, real) {
  const named = item => '<' + item.tagName.toLowerCase() + (item.id ? '#' + item.id : '') + (typeof item.className === 'string' && item.className.trim() ? '.' + item.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + '>';
  // real is what the browser itself finds at the point, through components of every kind (a shadow tree that keeps
  // its inside to itself too). It is not in the element's way where it is the element, inside it or around it, also
  // through components: going up from the one by what it is in and by the component its tree belongs to, and
  // counting what the page gave to a slot inside the other as inside that. Nor where it is the element's own label.
  // Words that stand in a component directly are handed over as the component's tree, which stands for the component.
  // A part of an element that the page draws without an element of its own (::before, ::after) is handed over as
  // something that is no node (all seen in a real Chrome): the page is then asked, below, and such a part of
  // something around the element is in its way, where the thing itself would not be.
  const drawn = real && real.nodeType === undefined;
  if (real && !drawn) {
    const hit = real.nodeType === 1 ? real : real.nodeType === 11 ? real.host : real.nodeType === 9 ? real.documentElement : real.parentElement || real.parentNode?.host;
    const holds = (outer, inner) => {
      const given = (outer.tagName === 'SLOT' ? [outer] : [...(outer.querySelectorAll?.('slot') || [])]).flatMap(slot => [...(slot.assignedNodes?.({ flatten: true }) || [])]);
      for (let node = inner, depth = 0; node && depth < 500; node = node.parentNode || node.host, depth++) if (node === outer || (node.nodeType === 1 && outer.contains(node)) || given.includes(node)) return true;
      return false;
    };
    const labels = () => { for (let node = hit, depth = 0; node && depth < 500; node = node.parentNode || node.host, depth++) if (node.tagName === 'LABEL' && node.control === this) return true; return false; };
    return !hit || holds(this, hit) || holds(hit, this) || labels() ? null : named(hit);
  }
  // Where the browser could not say, the tree the element is in is asked. A component (a shadow tree) answers with
  // what is inside it, one that keeps its inside to itself too; with what lies outside it where the point is on that;
  // and it names another component only by its outside (all seen in a real Chrome).
  const treeOf = node => node.getRootNode ? node.getRootNode() : document, own = treeOf(this), hit = own.elementFromPoint ? own.elementFromPoint(x, y) : null;
  // The element itself, what is inside it, and its own label are not in its way.
  if (!hit || hit === this || this.contains(hit) || hit.closest('label')?.control === this) return null;
  // Nor is what the page gave to a slot of the element (the words of a button that is a component): that is shown
  // inside it. What was given to another slot of the same component is not.
  const slots = this.tagName === 'SLOT' ? [this] : [...(this.querySelectorAll?.('slot') || [])];
  if (slots.some(slot => (slot.assignedNodes?.({ flatten: true }) || []).some(given => given === hit || given.contains?.(hit)))) return null;
  // What stands for the element in the tree of what was named: itself, or the component it is in, from there.
  let mine = this;
  for (let depth = 0; mine && treeOf(mine) !== treeOf(hit) && depth < 50; depth++) mine = treeOf(mine).host;
  if (!mine || (hit !== mine && !hit.contains(mine)) || drawn) return named(hit);
  // What was named is around the element. Where it is a component, the page has named it for something inside it:
  // that is in the element's way unless it is around the place the component shows the element in.
  if (hit !== mine && hit.shadowRoot) {
    const inside = hit.shadowRoot.elementFromPoint(x, y);
    let branch = mine;
    while (branch.parentNode && branch.parentNode !== hit) branch = branch.parentNode;
    if (inside && inside !== hit && !(branch.assignedSlot && (inside === branch.assignedSlot || inside.contains(branch.assignedSlot)))) return named(inside);
  }
  return null;
}
// Whether the page shows a text: written on it, or as what byText above finds an element by (what a field for text
// holds or asks for, a label, a title). What a password field holds is never looked at.
function shows(wanted) {
  if (!document.body) return false;
  const plain = name => typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '', sought = plain(wanted);
  if (!sought) return false;
  if (document.body.innerText.includes(wanted) || plain(document.body.innerText).includes(sought)) return true;
  // What a component shows (a shadow tree) is not in the text of the page: of each, what its own parts show. A part
  // that is not drawn is passed over, since the page would give its text all the same.
  // The page and two thousand components are looked into; that there are more is noticed and said.
  const trees = [document];
  let more = false;
  for (let at = 0; at < trees.length && !more; at++) for (const item of trees[at].querySelectorAll('*')) if (item.shadowRoot) { if (trees.length > 2000) { more = true; break; } trees.push(item.shadowRoot); }
  // What a piece of a component shows: a text as it stands, an element that is drawn by what it shows, and one that
  // only passes on what it holds (display: contents, as a slot does with what it shows when it was given no content)
  // by what that is. Anything else is not drawn. Pieces that stand side by side are read both with a blank between
  // them and without one, since which it is on the page cannot be told from here ("<b>Total</b>: 5").
  const styled = part => typeof getComputedStyle === 'function' ? getComputedStyle(part) : {}, passes = part => styled(part).display === 'contents';
  // Words that stand in something hidden are not shown; an element that is drawn says by itself what of it is hidden
  // (a part of a hidden component may be shown again), so only words without an element of their own are told here.
  const said = (part, glue, hidden) => part.nodeType === 3 ? (hidden ? '' : part.data) : part.nodeType !== 1 ? '' : part.getClientRects().length ? part.innerText
    : passes(part) && !part.assignedNodes?.().length ? [...part.childNodes].map(piece => said(piece, glue, styled(part).visibility === 'hidden')).join(glue) : '';
  // A component is displayed where it is drawn itself, or passes its content on to something that is.
  const displayed = part => {
    for (let at = part, step = 0; at && step < 50; at = at.parentElement || at.parentNode?.host, step++) { if (at.getClientRects().length) return true; if (!passes(at)) return false; }
    return false;
  };
  for (const tree of trees.slice(1)) {
    if (!tree.host || !displayed(tree.host)) continue;
    const hidden = styled(tree.host).visibility === 'hidden';
    for (const glue of [' ', '']) { const words = [...tree.childNodes].map(piece => said(piece, glue, hidden)).join(glue); if (words.includes(wanted) || plain(words).includes(sought)) return true; }
  }
  const named = trees.flatMap(tree => [...tree.querySelectorAll('[aria-label], [aria-labelledby], [title], [alt], [placeholder], input, textarea')]).slice(0, 5000).some(item => {
    if (!item.getClientRects().length) return false;
    const typed = item.tagName === 'TEXTAREA' || (item.tagName === 'INPUT' && !/^(password|hidden|checkbox|radio|file|range|color)$/i.test(item.type || ''));
    const tree = item.getRootNode ? item.getRootNode() : document;
    const labelled = (item.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => tree.getElementById?.(id)?.innerText || '').join(' ');
    return [typed ? item.value : '', item.getAttribute('aria-label'), labelled, item.getAttribute('title'), item.getAttribute('alt'), item.getAttribute('placeholder')].some(name => plain(name).includes(sought));
  });
  // More components than are looked into: the answer is then "not among those that were", which the caller says.
  return named || (more ? 'partly' : false);
}
function keyboard(clear) {
  let field = document.activeElement;
  // Of a component the page names only the outside: what has the keyboard is further in.
  while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
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
function look(names, most, real) {
  // What a password field holds is not shown where a page keeps it in the markup too.
  const style = getComputedStyle(this), box = this.getBoundingClientRect(), html = this.outerHTML.replace(/(<input\b(?=[^>]*\btype\s*=\s*["']?password\b)[^>]*?\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1"(hidden)"');
  // What is at its middle and is neither the element, nor inside it, nor around it: told as inFront above tells it.
  const x = box.x + box.width / 2, y = box.y + box.height / 2, treeOf = node => node.getRootNode ? node.getRootNode() : document, own = treeOf(this);
  const covering = () => {
    const drawn = real && real.nodeType === undefined;
    if (real && !drawn) {
      const found = real.nodeType === 1 ? real : real.nodeType === 11 ? real.host : real.nodeType === 9 ? real.documentElement : real.parentElement || real.parentNode?.host;
      const holds = (outer, inner) => {
        const given = (outer.tagName === 'SLOT' ? [outer] : [...(outer.querySelectorAll?.('slot') || [])]).flatMap(slot => [...(slot.assignedNodes?.({ flatten: true }) || [])]);
        for (let node = inner, depth = 0; node && depth < 500; node = node.parentNode || node.host, depth++) if (node === outer || (node.nodeType === 1 && outer.contains(node)) || given.includes(node)) return true;
        return false;
      };
      return !found || holds(this, found) || holds(found, this) ? null : found;
    }
    const hit = box.width && box.height && own.elementFromPoint ? own.elementFromPoint(x, y) : null;
    if (!hit || hit === this || this.contains(hit)) return null;
    const slots = this.tagName === 'SLOT' ? [this] : [...(this.querySelectorAll?.('slot') || [])];
    if (slots.some(slot => (slot.assignedNodes?.({ flatten: true }) || []).some(given => given === hit || given.contains?.(hit)))) return null;
    let mine = this;
    for (let depth = 0; mine && treeOf(mine) !== treeOf(hit) && depth < 50; depth++) mine = treeOf(mine).host;
    if (!mine || (hit !== mine && !hit.contains(mine)) || drawn) return hit;
    if (hit !== mine && hit.shadowRoot) {
      const inside = hit.shadowRoot.elementFromPoint(x, y);
      let branch = mine;
      while (branch.parentNode && branch.parentNode !== hit) branch = branch.parentNode;
      if (inside && inside !== hit && !(branch.assignedSlot && (inside === branch.assignedSlot || inside.contains(branch.assignedSlot)))) return inside;
    }
    return null;
  };
  const top = covering();
  return { tag: this.tagName.toLowerCase(), ...(this.id ? { id: this.id } : {}), ...(typeof this.className === 'string' && this.className ? { classes: this.className } : {}),
    box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0,
    ...(top ? { coveredBy: '<' + top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') + '>' } : {}),
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
    const session = { tabId, seq: 0, since: clock(), console: Object.assign([], { dropped: 0 }), requests: Object.assign([], { dropped: 0 }), byId: new Map(), waiters: new Set(), dialog: null, timer: null, awake: false, waking: null, put: false, undrawn: false, lent: 0 };
    sessions.set(tabId, session);
    try {
      // A page that was showing a dialog before the debugger came answers nothing, and that dialog cannot be answered
      // through the debugger: the browser says none is showing (seen in a real Chrome). So the first thing asked of
      // a tab is given five seconds, and then it is said what to do, instead of every call waiting half a minute.
      await new Promise((resolve, reject) => {
        const silent = schedule(() => reject(fail('browser_error', 'This tab does not answer the debugger. A page that was already showing a dialog (an alert, a question, "leave this page?") when DevMate first looked at it answers nothing until that dialog is closed, and it cannot be answered from here: close it in the browser, or load the page again with tabs.reload, which closes it.')), SILENT_MS);
        command(tabId, 'Runtime.enable').then(given => { cancel(silent); resolve(given); }, error => { cancel(silent); reject(error); });
      });
      for (const domain of ['Log', 'Network', 'Page']) await command(tabId, domain + '.enable');
    } catch (error) { await release(tabId); throw error; }
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
    touch(session);
    return { session, started };
  }
  // Every use of a tab starts its five minutes again.
  const touch = session => { cancel(session.timer); session.timer = schedule(() => { void release(session.tabId); }, IDLE_MS); };
  // A page that shows alert() or confirm() answers nothing else until the dialog is answered: say so instead of waiting.
  const inDialog = session => fail('dialog_open', 'The page is showing a dialog (' + dialogOf(session) + '). Nothing else works on this tab until it is answered: page.dialog with accept true or false.');
  const letGo = () => fail('browser_error', 'The debugger was taken off this tab before this was done: the owner took it off, or the tab was closed.');
  const page = async (tabId, { whileDialog = false } = {}) => {
    const tab = await target(tabId), held = await attached(tab.id);
    if (held.session.dialog && !whileDialog) throw inDialog(held.session);
    return { tab, id: tab.id, ...held };
  };
  // Something done to the page. When the page opens a dialog in answer to it, it is not waited for any longer, and
  // what is left of it is not done (work is told by halted()). When the tab is let go in the middle, it has failed.
  function unlessDialog(session, work) {
    // A dialog that opened since the call began (the page was brought to life, an element was scrolled to) is in the
    // way already: nothing is begun under it.
    if (session.dialog) return Promise.reject(inDialog(session));
    let wake, over = false;
    const dialog = new Promise(resolve => { wake = () => resolve(DIALOG); session.waiters.add(wake); }), doing = work(() => over);
    doing.catch(() => {});
    return Promise.race([doing, dialog]).then(result => {
      if (result === DIALOG && sessions.get(session.tabId) !== session) throw letGo();
      return result;
    }).finally(() => { over = true; session.waiters.delete(wake); });
  }
  const withDialog = (session, result) => session.dialog ? { ...result, dialog: dialogOf(session), note: 'The page opened a dialog and waits for it. Answer it with page.dialog.', untrusted: true } : result;
  // gesture: the page takes what is run as done by its user, and may then open windows, play sound or write to the
  // clipboard. Only what the caller has the page do is run that way; what this file asks the page about itself is not.
  const run = async (id, expression, { awaitPromise = false, gesture = false } = {}) => {
    const answer = await command(id, 'Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: gesture, timeout: 15000 });
    if (answer.exceptionDetails) throw fail('page_error', cut(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text, 1000));
    return answer.result;
  };
  // What is given to the function is data, or a node of the page by its handle ({ handle }).
  const onElement = async (id, objectId, work, ...given) => {
    const answer = await command(id, 'Runtime.callFunctionOn', { objectId, functionDeclaration: String(work), arguments: given.map(value => value === undefined ? {} : typeof value?.handle === 'string' ? { objectId: value.handle } : { value }), returnByValue: true, userGesture: work === choose });
    if (answer.exceptionDetails) throw fail('page_error', cut(answer.exceptionDetails.exception?.description || answer.exceptionDetails.text, 1000));
    return answer.result?.value;
  };
  // A tab behind another, or in a window that is put away, the browser treats as not shown. It draws nothing of it. A
  // page it has never drawn it gives no click and no key, while answering that they were given; a pointer moved there
  // is answered after five seconds, a turn of the wheel never (all seen in a real Chrome). Told that it has the focus,
  // the page is drawn and given all of that where it is, so nothing is brought forward on the owner's screen: what
  // DevTools calls "Emulate a focused page". What uses the mouse or the keys on a page does this, and it then lasts
  // while the tab is debugged. A picture does it for as long as the picture takes (see capture). Any other read leaves
  // a tab that is put away as it is: a page that believes it is looked at may mark things as read, or go on playing.
  const hidden = async id => (await run(id, 'document.visibilityState'))?.value === 'hidden';
  const wake = (id, enabled = true) => raw(id, 'Emulation.setFocusEmulationEnabled', { enabled }).catch(() => {});
  // One waking at a time for a tab: whoever asks meanwhile waits for the same one, and a picture that ends while it
  // is under way does not put the tab away again.
  function awake(id, session) {
    if (session.awake) return Promise.resolve();
    return session.waking ||= (async () => {
      // Put away now, shown only for a picture that is being taken, or woken before and interrupted: in each case
      // the page may not have been drawn yet.
      // A page may answer being looked at with a dialog (seen in a real Chrome with one that says "your session has
      // expired" when it gets the focus). The browser then answers nothing more for the tab, not even the telling
      // itself, so all of it is done under the watch for a dialog, and one is said at once.
      const still = await unlessDialog(session, async halted => {
        const put = await hidden(id) || session.lent > 0 || session.undrawn;
        if (halted()) return false;
        if (put) session.put = session.undrawn = true;
        await wake(id);
        if (!put) return false;
        // A page that was never drawn takes a click only once it has been: it is given two frames, or two seconds.
        await run(id, 'new Promise(done => { requestAnimationFrame(() => requestAnimationFrame(() => done())); setTimeout(done, 2000); })', { awaitPromise: true }).catch(() => {});
        return hidden(id);
      });
      if (still === DIALOG) throw inDialog(session);
      if (still) {
        // What did not help is not left switched on.
        if (!session.lent) await wake(id, false);
        throw fail('invalid_input', 'The browser is not showing this tab and could not be made to draw it where it is, so a click, a key or the wheel may never arrive there. Bring it forward (tabs.activate) and ask again.');
      }
      session.undrawn = false;
      session.awake = true;
    })().finally(() => { session.waking = null; });
  }

  // What uses the mouse or the keys on a page, under the watch for a dialog from its first step: whichever of them
  // brings a dialog up (bringing the page to life, giving a field the keyboard, the click itself) ends the call at
  // once. work(halted, did) begins nothing once halted() is true, so a step the dialog held up does not go on to
  // click or type after the dialog is answered; and it calls did() before the first thing it sends. What is answered
  // is what was done: with the dialog named where something was sent, and as a refusal where nothing was.
  async function acting(session, work, done) {
    let made = false;
    const ended = await unlessDialog(session, halted => work(halted, () => { made = true; }));
    if (ended === DIALOG && !made) throw inDialog(session);
    return withDialog(session, done());
  }
  // The element a call uses the mouse or the keys on, on a tab that is awake. It is looked for first, so that a call
  // which names nothing wakes nothing. A tab that is put away may hold the element only once it is drawn, and may
  // draw itself anew when it is woken: there it is looked for again after the waking.
  async function aimed(id, session, which) {
    if (session.awake) return element(id, which);
    const before = await element(id, which).catch(error => { if (error.code !== 'not_found') throw error; return null; });
    await awake(id, session);
    return before && !session.put ? before : element(id, which);
  }

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
    // A text is looked for in the page and in the components that show their inside, a selector in the page alone.
    if (!answer.result?.objectId) throw fail('not_found', 'No element on the page matches ' + (selector !== undefined ? 'the selector ' + selector : 'the text "' + shown + '"') +
      '. page.snapshot lists what is there with a ref for each, also inside a component that keeps its inside to itself. What is inside a frame (iframe) is not reached.');
    return answer.result.objectId;
  }
  // The middle of an element as it is drawn (of its first box), where it has one.
  const middle = async (id, objectId) => {
    const quad = ((await raw(id, 'DOM.getContentQuads', { objectId }).catch(() => null))?.quads || []).find(one => one.length === 8);
    return quad ? { x: Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4), y: Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4) } : null;
  };
  // What the browser itself finds at a point of the page, as a node handed to the page's own functions. The browser
  // sees through components of every kind, also into one that keeps its inside to itself, where the page is told
  // only its outside (seen in a real Chrome). Nothing where it cannot say: a point that is not shown.
  // The browser takes the point as a point of the document, where everything else here (the boxes of an element, the
  // mouse) is told in points of what the window shows: asked at those, on a page that is scrolled it found nothing,
  // or something else (seen in a real Chrome). So where the page is scrolled to is added.
  const atPoint = async (id, x, y) => {
    try {
      const metrics = await raw(id, 'Page.getLayoutMetrics'), shown = metrics?.cssLayoutViewport || metrics?.layoutViewport || {};
      const found = await raw(id, 'DOM.getNodeForLocation', { x: Math.round(x + (shown.pageX || 0)), y: Math.round(y + (shown.pageY || 0)), includeUserAgentShadowDOM: false });
      const node = found?.backendNodeId ? await raw(id, 'DOM.resolveNode', { backendNodeId: found.backendNodeId }) : null;
      return node?.object?.objectId ? { handle: node.object.objectId } : undefined;
    } catch { return undefined; }
  };
  // A function that is told what is at the point. A node of another page inside this one (a frame) cannot be handed
  // over: the function is then asked without it, and judges by what the page itself names there. The node is given
  // back to the browser afterwards, so that it does not keep a part of the page alive that the page has let go of.
  const told = async (id, objectId, work, given, real) => {
    if (!real) return onElement(id, objectId, work, ...given);
    try { return await onElement(id, objectId, work, ...given, real).catch(() => onElement(id, objectId, work, ...given)); }
    finally { void raw(id, 'Runtime.releaseObject', { objectId: real.handle }).catch(() => {}); }
  };
  // Where to point at an element: the middle of it, once it is scrolled into view. Refused when something else is there.
  async function point(id, objectId) {
    await raw(id, 'DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => {});
    const at = await middle(id, objectId);
    if (!at) throw fail('not_found', 'The element is not shown on the page, so it cannot be pointed at. page.inspect says how it is laid out.');
    const { x, y } = at, above = await told(id, objectId, inFront, [x, y], await atPoint(id, x, y));
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
      // A frame of the page (an iframe) holds another page, which is not in this list. It is shown with the address
      // of that page, named or not, so that a page whose content is in a frame does not look empty.
      // The address is asked for the first hundred frames as they are listed; one beyond those is shown without. A frame that
      // has no page of its own yet (about:blank) is shown with what it was told to load, and one whose content is
      // written into the page itself (srcdoc) has no address a tab could open.
      // Only an address a tab can be opened at is shown (http or https), not one that is a script or holds the content itself.
      const framed = [], frames = new Map(), web = address => /^https?:\/\//i.test(address) ? address : '';
      for (const stack = [nodes.find(node => !node.parentId) || nodes[0]]; stack.length;) {
        const node = stack.pop();
        if (!node) continue;
        if (!node.ignored && FRAMES.has(node.role?.value)) { framed.push(node); frames.set(node.nodeId, ''); }
        for (const child of [...(node.childIds || [])].reverse()) stack.push(byId.get(child));
      }
      await Promise.all(framed.filter(node => node.backendDOMNodeId).slice(0, 100).map(async node => {
        const told = (await raw(id, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId }).catch(() => null))?.node, given = told?.attributes || [], named = name => { const at = given.indexOf(name); return at >= 0 && at % 2 === 0 ? given[at + 1] : undefined; };
        let address = web(told?.contentDocument?.documentURL || '');
        if (!address && named('srcdoc') === undefined && named('src')) { try { address = web(new URL(named('src'), tab.url || undefined).href); } catch { address = ''; } }
        frames.set(node.nodeId, address);
      }));
      // The lines of a node and of what it holds.
      const walk = (node, depth, above) => {
        const role = node.role?.value || '', name = cut(node.name?.value || '', 160), value = node.value?.value, said = value !== undefined && value !== '', frame = frames.has(node.nodeId);
        // A text that only repeats the name of what holds it says nothing new.
        const shown = !node.ignored && !SILENT.has(role) && !(role === 'StaticText' && (!name || above.includes(name))) && (interactiveOnly !== true || INTERACTIVE.has(role) || frame);
        const below = (node.childIds || []).flatMap(child => { const next = byId.get(child); return next ? walk(next, shown && interactiveOnly !== true ? depth + 1 : depth, shown && name ? name : above) : []; });
        // Something that only holds other things, and holds nothing that is shown, is left out.
        if (!shown || (!name && !said && !INTERACTIVE.has(role) && !frame && !below.length)) return below;
        const properties = node.properties || [], states = properties.filter(item => STATES.includes(item.name) && item.value?.value && item.value.value !== 'false').map(item => item.name + (item.value.value === true || item.value.value === 'true' ? '' : '=' + item.value.value));
        const address = role === 'link' ? properties.find(item => item.name === 'url')?.value?.value : frames.get(node.nodeId) || undefined;
        return ['  '.repeat(Math.min(depth, 12)) + (node.backendDOMNodeId && role !== 'StaticText' ? '[' + node.backendDOMNodeId + '] ' : '') + (role === 'StaticText' ? 'text' : frame ? 'frame' : role) + (name ? ' "' + name + '"' : '') +
          (said ? ' value="' + cut(value, 120) + '"' : '') + (address ? ' → ' + cut(address, 200) : '') + (states.length ? ' (' + states.join(', ') + ')' : '') + (frame ? ' (another page inside this one: what it holds is not listed here)' : ''), ...below];
      };
      const root = nodes.find(node => !node.parentId) || nodes[0], all = root ? walk(root, 0, '') : [];
      return { tabId: id, title: tab.title || '', url: tab.url || '', text: all.slice(0, most).join('\n'), nodes: Math.min(all.length, most), ...(all.length > most ? { truncated: true, leftOut: all.length - most } : {}), untrusted: true };
    },
    'page.inspect': async ({ tabId, ref, selector, text: shown, styles, maxChars } = {}) => {
      if (styles !== undefined && (!Array.isArray(styles) || !styles.length || styles.length > 60 || styles.some(name => typeof name !== 'string' || !/^[a-z-]{1,60}$/i.test(name)))) throw fail('invalid_input', 'styles is a list of 1 to 60 CSS property names.');
      const most = Math.min(100000, whole(maxChars, 'maxChars', { optional: true, min: 100 }) ?? 4000), { id } = await page(tabId);
      // What covers it is judged as a click would judge it, at the middle of the element as it is drawn.
      const objectId = await element(id, { ref, selector, text: shown }), at = await middle(id, objectId);
      return { tabId: id, ...(await told(id, objectId, look, [styles || STYLES, most], at ? await atPoint(id, at.x, at.y) : undefined)), untrusted: true };
    },
    'page.storage': async ({ tabId, includeValues } = {}) => {
      const { id } = await page(tabId), kept = (await run(id, inPage(stores, includeValues === true))).value, { cookies = [] } = await command(id, 'Network.getCookies');
      return { tabId: id, ...kept, cookies: cookies.slice(0, 200).map(item => ({ name: item.name, domain: item.domain, path: item.path, ...(item.expires > 0 ? { expires: new Date(item.expires * 1000).toISOString() } : { session: true }),
        ...(item.httpOnly ? { httpOnly: true } : {}), ...(item.secure ? { secure: true } : {}), ...(item.sameSite ? { sameSite: item.sameSite } : {}), chars: item.value.length, ...(includeValues === true ? { value: cut(item.value, 2000) } : {}) })), untrusted: true };
    },
    'page.waitFor': async ({ tabId, selector, text: shown, timeoutMs } = {}) => {
      if ((selector === undefined) === (shown === undefined)) throw fail('invalid_input', 'Say what to wait for: selector, or text.');
      const limit = whole(timeoutMs, 'timeoutMs', { optional: true, min: 100, max: 30000 }) ?? 10000, began = clock();
      const expression = selector !== undefined ? '!!document.querySelector(' + JSON.stringify(text(selector, 'selector', { max: 1000 })) + ')' : inPage(shows, text(shown, 'text', { max: 500 }));
      // The tab is the one that was in front when this was asked, whatever the owner turns to while it waits.
      const { id, session } = await page(tabId);
      let partly = false;
      for (;;) {
        // A page that is between two addresses has nothing to ask yet: that is a "not yet", not a failure.
        const seen = await run(id, expression).then(result => result.value, error => { if (error.code === 'page_error' && selector !== undefined) throw fail('invalid_input', 'The selector is not valid: ' + error.message); return false; });
        if (seen === true) return { tabId: id, found: true, ms: clock() - began };
        partly = seen === 'partly';
        // A tab that was let go while it was asked has not been waited for to the end: said as that.
        if (sessions.get(id) !== session) throw letGo();
        if (clock() - began >= limit) throw fail('timeout', (selector !== undefined ? 'Nothing matches ' + selector + ' after ' + limit + ' ms.'
          : 'The text "' + shown + '" did not show on the page within ' + limit + ' ms. What a frame of the page holds is not looked at, nor what a component holds that keeps its inside to itself (page.snapshot lists that).' +
            (partly ? ' This page has more components than are looked into (two thousand): the text may be in one of the others.' : '')));
        await pause(250);
        // Still debugged, and no dialog in the way. A tab the owner has let go of meanwhile is not taken again.
        if (sessions.get(id) !== session) throw letGo();
        if (session.dialog) throw inDialog(session);
        touch(session);
      }
    },

    'page.click': async ({ tabId, ref, selector, text: shown, double } = {}) => {
      const { id, session } = await page(tabId);
      let at;
      return acting(session, async (halted, did) => {
        const spot = await point(id, await aimed(id, session, { ref, selector, text: shown })), button = { x: spot.x, y: spot.y, button: 'left' };
        if (halted()) return;
        await command(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
        // A button that was pressed is let go whatever happens; a second click is not begun once the first was answered with a dialog.
        for (let count = 1; count <= (double === true ? 2 : 1) && !halted(); count++) {
          at = spot; did();
          await command(id, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...button, buttons: 1, clickCount: count });
          await command(id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, clickCount: count });
        }
      }, () => ({ tabId: id, clicked: at }));
    },
    'page.hover': async ({ tabId, ref, selector, text: shown } = {}) => {
      const { id, session } = await page(tabId);
      let at;
      return acting(session, async (halted, did) => {
        const spot = await point(id, await aimed(id, session, { ref, selector, text: shown }));
        if (halted()) return;
        at = spot; did();
        await command(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
      }, () => ({ tabId: id, hovered: at }));
    },
    'page.type': async ({ tabId, ref, selector, text: typed, clear } = {}) => {
      if (typeof typed !== 'string' || typed.length > 100000) throw fail('invalid_input', 'text is what to type, at most 100000 characters.');
      const { id, session } = await page(tabId);
      let into, sent = 0;
      return acting(session, async (halted, did) => {
        const objectId = ref !== undefined || selector !== undefined ? await aimed(id, session, { ref, selector }) : null;
        if (!objectId) await awake(id, session);
        if (halted()) return;
        if (objectId) await raw(id, 'DOM.focus', { objectId }).catch(() => { throw fail('invalid_input', 'This element cannot take the keyboard: it is not something to type into.'); });
        if (halted()) return;
        into = (await run(id, inPage(keyboard, clear === true))).value;
        if (!into) throw fail('invalid_input', 'Nothing on the page has the keyboard. Say where to type: ref or selector.');
        // Emptied the way a person empties a field: everything selected, then deleted.
        if (clear === true && !halted()) { did(); await press(id, 'Delete'); }
        if (typed && !halted()) { did(); sent = typed.length; await command(id, 'Input.insertText', { text: typed }); }
      }, () => ({ tabId: id, typed: sent, into, untrusted: true }));
    },
    'page.press': async ({ tabId, key: name, modifiers } = {}) => {
      const held = modifiers === undefined ? [] : modifiers;
      if (!Array.isArray(held) || held.some(one => !Object.hasOwn(MODIFIERS, one))) throw fail('invalid_input', 'modifiers is a list of: ' + Object.keys(MODIFIERS).join(', ') + '.');
      // A named key is taken however it is written (enter, ENTER); a letter keeps the case it was given in.
      const known = typeof name !== 'string' ? null : /^[a-z0-9]$/i.test(name) ? name : Object.keys(KEYS).find(one => one.toLowerCase() === name.toLowerCase());
      if (!known) throw fail('invalid_input', 'key is one letter or digit, or one of: ' + Object.keys(KEYS).join(', ') + '.');
      const { id, session } = await page(tabId);
      return acting(session, async (halted, did) => {
        await awake(id, session);
        if (halted()) return;
        did();
        await press(id, known, held);
      }, () => ({ tabId: id, pressed: [...held, known].join('+') }));
    },
    'page.select': async ({ tabId, ref, selector, value, label } = {}) => {
      if ((value === undefined) === (label === undefined)) throw fail('invalid_input', 'Say which choice: value, or label (the text it shows).');
      const wanted = value !== undefined ? text(value, 'value', { max: 1000 }) : undefined, named = label !== undefined ? text(label, 'label', { max: 1000 }) : undefined, { id, session } = await page(tabId);
      // A page may answer a choice with a dialog ("change the country and lose the basket?"): the choice is made by then.
      const chosen = await unlessDialog(session, async () => onElement(id, await element(id, { ref, selector }), choose, wanted, named));
      if (chosen === DIALOG) return withDialog(session, { tabId: id });
      if (chosen?.problem === 'not a list') throw fail('invalid_input', 'This element is not a <select>. A list built from other elements is opened with page.click and chosen from the same way.');
      if (chosen?.problem) throw fail('not_found', 'The list has no such choice. It offers: ' + (chosen.choices || []).join(' | '));
      return { tabId: id, selected: chosen, untrusted: true };
    },
    'page.scroll': async ({ tabId, ref, selector, deltaY } = {}) => {
      const { id, session } = await page(tabId);
      if (ref !== undefined || selector !== undefined) return acting(session, async (halted, did) => {
        const objectId = await element(id, { ref, selector });
        if (halted()) return;
        did();
        await command(id, 'DOM.scrollIntoViewIfNeeded', { objectId });
      }, () => ({ tabId: id, scrolledTo: ref ?? selector }));
      const by = whole(deltaY, 'deltaY', { min: -100000, max: 100000 });
      return acting(session, async (halted, did) => {
        await awake(id, session);
        const view = (await command(id, 'Page.getLayoutMetrics')).cssVisualViewport || {};
        if (halted()) return;
        did();
        await command(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round((view.clientWidth || 800) / 2), y: Math.round((view.clientHeight || 600) / 2), deltaX: 0, deltaY: by });
      }, () => ({ tabId: id, scrolledBy: by }));
    },
    'page.evaluate': async ({ tabId, expression, awaitPromise } = {}) => {
      const source = text(expression, 'expression', { max: 100000 }), { id, session } = await page(tabId), result = await unlessDialog(session, () => run(id, source, { awaitPromise: awaitPromise !== false, gesture: true }));
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
    const { id, tab, session } = await page(tabId);
    // The browser draws only what it shows, so a tab that is put away is first told that it is looked at (see awake).
    // A picture is a read, so it is lent only: for as long as pictures of the tab are being taken, and no longer,
    // unless the mouse or the keys have woken the tab meanwhile, or are about to.
    let lent = false;
    // Of a tab that is put away the browser may still leave a picture unanswered, and gives it when it is asked again
    // (seen in a real Chrome: each one came by the third asking). So of such a tab it is asked again until one answer
    // has come, and after ten seconds it is said what to do. A tab the browser shows is asked once and waited for as
    // long as its picture takes. halted: a dialog has opened, and nothing more is asked.
    const pictured = (params, halted, again) => new Promise((resolve, reject) => {
      let asks = 0, timer;
      const ended = settle => given => { cancel(timer); settle(given); };
      const ask = () => {
        if (halted()) return;
        if (asks === PICTURE_AGAIN_MS.length) return reject(fail('invalid_input', 'The browser gave no picture of this tab in ten seconds. If it is behind another tab, bring it forward (tabs.activate) and ask again.'));
        command(id, 'Page.captureScreenshot', params).then(ended(resolve), ended(reject));
        if (again) timer = schedule(ask, PICTURE_AGAIN_MS[asks++]);
      };
      ask();
    });
    try {
      // A page may answer being looked at with a dialog. Then it gives no picture until that is answered, and neither
      // the telling nor the asking how it is shown is answered: all of it is done under the watch for a dialog, and
      // nothing is begun, or counted, once one has opened.
      const taken = await unlessDialog(session, async halted => {
        const away = !session.awake && (session.lent > 0 || await hidden(id));
        if (halted()) return null;
        lent = away;
        if (lent && session.lent++ === 0) await wake(id);
        const again = lent || session.put || tab.active === false;
        if (!fullPage) return { tabId: id, mimeType: 'image/png', base64: (await pictured({ format: 'png' }, halted, again)).data };
        // A long page is cut at a height a model can still read, and sent as JPEG so that it stays small.
        const size = (await command(id, 'Page.getLayoutMetrics')).cssContentSize || {}, width = Math.min(Math.ceil(size.width || 1280), 4096), tall = Math.ceil(size.height || 800), height = Math.min(tall, 8000);
        const shot = await pictured({ format: 'jpeg', quality: 85, clip: { x: 0, y: 0, width, height, scale: 1 }, captureBeyondViewport: true }, halted, again);
        return { tabId: id, mimeType: 'image/jpeg', base64: shot.data, fullPage: true, width, height, ...(tall > height ? { truncated: true, pageHeight: tall } : {}) };
      });
      if (taken === DIALOG) throw inDialog(session);
      return taken;
    } finally {
      // Under a dialog the browser answers this only once the dialog is answered: it is sent, and not waited for.
      if (lent && --session.lent === 0 && !session.awake && !session.waking) { const back = wake(id, false); if (!session.dialog) await back; }
    }
  }

  return { methods, capture, release, debugging: () => [...sessions.keys()] };
}
