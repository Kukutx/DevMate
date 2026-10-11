import { READ_ONLY, answer } from './capabilities.js';

// The link between this extension and the DevMate runtime on the same computer. Chrome starts DevMate's native
// messaging host for this extension and for no other; everything goes over that one connection, in both directions:
//
//   the runtime asks the browser to do something  → { type: 'call', id, method, params }   ← { type: 'result', id, ok, result | error }
//   this extension, as an entry, asks the runtime → { type: 'request', id, action, input } ← { type: 'response', id, ok, result | error }
//   the runtime tells what happened               → { type: 'event', name, data }
//
// As an entry the extension can ask for five things and nothing else: the status, a start, a link to the workbench,
// the MCP address, and what waits for the owner. It cannot stop the runtime and cannot call an operation by name.
//
// The owner sees what happens here: every call the runtime made of this browser is kept in a short list (what, when,
// whether it worked; never what it carried), and one switch stops all of it.

export const HOST = 'io.github.kukutx.devmate';
export const PROTOCOL = 1;
export const ACTIONS = Object.freeze(['status', 'start', 'workbench', 'mcpUrl', 'pending']);
const REQUEST_TIMEOUT_MS = 30000;
// Starting waits for a runtime to come up.
const START_TIMEOUT_MS = 90000;
const ACTIVITY_KEPT = 30;
// What the browser says when no host is registered for this extension, or the registration names another extension.
const NOT_REGISTERED = /host not found|is forbidden|not installed|not registered/i;

export function createBridge({ connect, methods, version = '', browser = '', settings, onChange = () => {}, schedule = (run, ms) => setTimeout(run, ms), cancel = clearTimeout, clock = () => Date.now() } = {}) {
  let port = null, next = 1, retry = null, delay = 1000;
  const waiting = new Map(), activity = [];
  // What the panel shows. host: 'connecting' | 'connected' | 'missing' | 'closed'. said: the browser's own words when
  // a connection ended, kept as they are; attempts: how often a connection was tried since the last one that held.
  const state = { host: 'closed', said: null, saidAt: null, attempts: 0, runtime: null, pending: 0, paused: false };
  const view = () => ({ ...state, activity: activity.slice(0, 12), calls: activity.length });
  const changed = () => onChange(view());
  const send = message => { try { port?.postMessage(message); return true; } catch { return false; } };

  function request(action, input) {
    if (!ACTIONS.includes(action)) return Promise.reject(Object.assign(new Error('The extension cannot ask DevMate for ' + action + '.'), { code: 'invalid_input' }));
    if (!port || state.host !== 'connected') return Promise.reject(Object.assign(new Error(state.said || 'DevMate is not connected to this browser yet.'), { code: 'not_connected' }));
    const id = next++;
    return new Promise((resolve, reject) => {
      const timer = schedule(() => { waiting.delete(id); reject(Object.assign(new Error('DevMate did not answer in time.'), { code: 'timeout' })); }, action === 'start' ? START_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      if (!send({ type: 'request', id, action, ...(input !== undefined ? { input } : {}) })) { cancel(timer); waiting.delete(id); reject(Object.assign(new Error('DevMate is not connected to this browser.'), { code: 'not_connected' })); }
    });
  }

  // One call of the runtime: refused while the owner has paused the browser, run otherwise, and noted either way.
  async function called(message) {
    const started = clock(), saved = await settings.get();
    state.paused = saved.paused === true;
    const outcome = state.paused
      ? { ok: false, error: { code: 'paused', message: 'The owner has paused DevMate\'s use of this browser. They switch it back on in the DevMate extension.' } }
      : await answer(methods, message.method, message.params);
    send({ type: 'result', id: message.id, ...outcome });
    activity.unshift({ at: started, method: String(message.method).slice(0, 60), read: READ_ONLY.includes(message.method), ok: outcome.ok, ...(outcome.ok ? {} : { code: outcome.error.code }), ms: clock() - started });
    if (activity.length > ACTIVITY_KEPT) activity.length = ACTIVITY_KEPT;
    changed();
  }

  async function received(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      state.host = 'connected'; state.said = null; state.saidAt = null; state.attempts = 0; state.runtime = message.runtime || null; delay = 1000;
      const saved = await settings.get();
      state.paused = saved.paused === true;
      changed();
      // "Start DevMate with the browser": the same switch an editor has, off until the owner turns it on.
      if (state.runtime?.running !== true && saved.startWithBrowser === true) request('start').then(runtime => { state.runtime = runtime || state.runtime; changed(); }, () => {});
      else if (state.runtime?.running === true) request('pending').then(result => { state.pending = Number(result?.count) || 0; changed(); }, () => {});
    } else if (message.type === 'call') await called(message);
    else if (message.type === 'response') {
      const asked = waiting.get(message.id);
      if (!asked) return;
      waiting.delete(message.id); cancel(asked.timer);
      if (message.ok) asked.resolve(message.result);
      else asked.reject(Object.assign(new Error(String(message.error?.message || 'DevMate refused this.')), { code: message.error?.code || 'refused' }));
    } else if (message.type === 'event') {
      if (message.name === 'runtime.status') { state.runtime = message.data || null; if (state.runtime?.running !== true) state.pending = 0; }
      else if (message.name === 'approval.created' || message.name === 'input.created') state.pending = Number(message.data?.pending) || state.pending + 1;
      else if (message.name === 'pending.changed') state.pending = Number(message.data?.count) || 0;
      else if (message.name === 'connection.verified') state.runtime = { ...(state.runtime || {}), route: message.data || null };
      changed();
    }
  }

  function dropped(reason) {
    port = null;
    for (const asked of waiting.values()) { cancel(asked.timer); asked.reject(Object.assign(new Error('The connection to DevMate was closed.'), { code: 'not_connected' })); }
    waiting.clear();
    const missing = NOT_REGISTERED.test(reason || '');
    state.host = missing ? 'missing' : 'closed'; state.runtime = null; state.pending = 0;
    state.said = reason || 'The connection to DevMate was closed.'; state.saidAt = clock(); state.attempts++;
    changed();
    // A registration is made on the computer, not by trying again fast: look again every half minute.
    if (retry === null) retry = schedule(() => { retry = null; open(); }, missing ? 30000 : delay);
    delay = Math.min(delay * 2, 30000);
  }

  function open() {
    if (port) return;
    state.host = 'connecting'; changed();
    let link;
    try { link = connect(HOST); } catch (error) { dropped(String(error?.message || error)); return; }
    port = link;
    link.onMessage.addListener(message => { if (port === link) void received(message); });
    link.onDisconnect.addListener(reason => { if (port === link) dropped(typeof reason === 'string' ? reason : ''); });
    send({ type: 'hello', protocol: PROTOCOL, extension: version, browser, methods: Object.keys(methods) });
  }
  // The owner asked for another try: at once, whatever the wait was.
  function again() {
    if (state.host === 'connected' || state.host === 'connecting') return;
    if (retry !== null) { cancel(retry); retry = null; }
    delay = 1000;
    open();
  }
  async function pause(paused) { await settings.set({ paused: paused === true }); state.paused = paused === true; changed(); }

  return { open, again, pause, request, state: view, connected: () => state.host === 'connected' };
}
