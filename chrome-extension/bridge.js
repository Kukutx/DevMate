import { READ_ONLY, answer } from './capabilities.js';

// The link between this extension and the DevMate runtime on the same computer. Chrome starts DevMate's native
// messaging host for this extension and for no other; everything goes over that one connection, in both directions:
//
//   the runtime asks the browser to do something  → { type: 'call', id, method, params }   ← { type: 'result', id, ok, result | error }
//   this extension, as an entry, asks the runtime → { type: 'request', id, action, input } ← { type: 'response', id, ok, result | error }
//   the runtime tells what happened               → { type: 'event', name, data }
//   the host will not serve this browser          → { type: 'refused', message }, and it ends
//   the owner paused this browser, or let it go on → { type: 'state', paused }
//
// As an entry the extension can ask for six things and nothing else: the status, a start, a link to the workbench,
// the MCP address, what waits for the owner, and that this browser be the one DevMate uses where several are
// connected. It cannot stop the runtime and cannot call an operation by name.
//
// The owner sees what happens here: every call the runtime made of this browser is kept in a short list (what, when,
// whether it worked; never what it carried), and one switch stops all of it.

export const HOST = 'io.github.kukutx.devmate';
export const PROTOCOL = 1;
export const ACTIONS = Object.freeze(['status', 'start', 'workbench', 'mcpUrl', 'pending', 'prefer']);
const REQUEST_TIMEOUT_MS = 30000;
// Starting waits for a runtime to come up.
const START_TIMEOUT_MS = 90000;
const ACTIVITY_KEPT = 30;
// What the browser says when no host is registered for this extension, or the registration names another extension.
const NOT_REGISTERED = /host not found|is forbidden|not installed|not registered/i;

export function createBridge({ connect, methods, version = '', browser = '', settings, onChange = () => {}, schedule = (run, ms) => setTimeout(run, ms), cancel = clearTimeout, clock = () => Date.now() } = {}) {
  let port = null, next = 1, retry = null, delay = 1000, refusal = null, looking = false;
  // Whether the owner's pause is known yet (it is read from what the browser keeps), and what the host was last told of it.
  let known = false, told;
  const waiting = new Map(), activity = [];
  // What the panel shows. host: 'connecting' | 'connected' | 'missing' | 'closed'. said: the browser's own words when
  // a connection ended, kept as they are; attempts: how often a connection was tried since the last one that held.
  // link: where several browsers are connected, whether this is the one DevMate uses ({ current, browsers }), as the
  // host last said. startSaid: why a start "with the browser" did not work, in DevMate's words.
  const state = { host: 'closed', said: null, saidAt: null, attempts: 0, runtime: null, pending: 0, paused: false, link: null, startSaid: null };
  const view = () => ({ ...state, activity: activity.slice(0, 12), calls: activity.length });
  const changed = () => onChange(view());
  const send = message => { try { port?.postMessage(message); return true; } catch { return false; } };
  // The runtime sends its calls to a browser the owner has not paused, where there is one: it is told of the pause.
  const tell = () => { if (port && state.host === 'connected' && told !== state.paused && send({ type: 'state', paused: state.paused })) told = state.paused; };
  const linked = data => ({ current: data?.current === true, browsers: Math.max(0, Math.floor(Number(data?.browsers) || 0)) });

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
    state.paused = saved.paused === true; known = true;
    tell();
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
      if (state.runtime?.running === true) state.startSaid = null;
      const saved = await settings.get();
      state.paused = saved.paused === true; known = true;
      tell();
      changed();
      // "Start DevMate with the browser": the same switch an editor has, off until the owner turns it on. Where the
      // start does not work (another program has the port), the panel says why: nobody was there to see it fail.
      if (state.runtime?.running !== true && saved.startWithBrowser === true) request('start').then(runtime => { state.runtime = runtime || state.runtime; state.startSaid = null; changed(); },
        error => { if (error?.code !== 'not_connected') { state.startSaid = String(error?.message || '').slice(0, 600) || null; changed(); } });
      else if (state.runtime?.running === true) request('pending').then(result => { state.pending = Number(result?.count) || 0; changed(); }, () => {});
    // The host says why it will not serve this browser, and ends: its words are what the panel shows, in place of the
    // browser's "Native host has exited", which tells the owner nothing.
    } else if (message.type === 'refused') refusal = String(message.message || '').slice(0, 600) || null;
    else if (message.type === 'call') await called(message);
    else if (message.type === 'response') {
      const asked = waiting.get(message.id);
      if (!asked) return;
      waiting.delete(message.id); cancel(asked.timer);
      if (message.ok) asked.resolve(message.result);
      else asked.reject(Object.assign(new Error(String(message.error?.message || 'DevMate refused this.')), { code: message.error?.code || 'refused' }));
    } else if (message.type === 'event') {
      if (message.name === 'runtime.status') { state.runtime = message.data || null; if (state.runtime?.running !== true) { state.pending = 0; state.link = null; } else state.startSaid = null; }
      else if (message.name === 'link.status') state.link = linked(message.data);
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
    const missing = NOT_REGISTERED.test(reason || ''), refused = refusal;
    refusal = null;
    state.host = missing ? 'missing' : 'closed'; state.runtime = null; state.pending = 0; state.link = null; state.startSaid = null; told = undefined;
    state.said = refused || reason || 'The connection to DevMate was closed.'; state.saidAt = clock(); state.attempts++;
    changed();
    // A registration is made on the computer, not by trying again fast: look again every half minute. The same where
    // the host said why it will not serve: what it named does not change by itself either.
    if (retry === null) retry = schedule(() => { retry = null; open(); }, missing || refused ? 30000 : delay);
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
    // (paused: said where it is known, which it is from the first answer on; until then the host hears it right after.)
    send({ type: 'hello', protocol: PROTOCOL, extension: version, browser, methods: Object.keys(methods), ...(known ? { paused: state.paused } : {}) });
    told = known ? state.paused : undefined;
  }
  // The owner asked for another try: at once, whatever the wait was.
  function again() {
    if (state.host === 'connected' || state.host === 'connecting') return;
    if (retry !== null) { cancel(retry); retry = null; }
    delay = 1000;
    open();
  }
  // A host can be there and serve nobody: it stopped reading, or it ended its work and its process stayed. The
  // browser then reports no disconnect, and this extension would call itself connected for as long as the browser
  // runs. So the host is asked how DevMate is, now and then; one that gives no answer at all is let go, and the
  // browser starts another. (An answer that is a refusal or an error is an answer.)
  async function look() {
    // (Where no host has answered yet, the request itself is refused at once and nothing is sent.)
    if (looking) return;
    const link = port;
    looking = true;
    try { state.runtime = await request('status') || state.runtime; changed(); }
    catch (error) {
      if (error?.code === 'timeout' && port === link) { try { link.disconnect?.(); } catch { /* it is gone already */ } dropped('DevMate\'s host for this browser did not answer.'); }
    } finally { looking = false; }
  }
  async function pause(paused) { await settings.set({ paused: paused === true }); state.paused = paused === true; known = true; tell(); changed(); }
  // "Use this browser": the owner's choice among the browsers that are connected. It lifts no pause.
  async function prefer() { state.link = linked(await request('prefer')); changed(); return state.link; }

  return { open, again, look, pause, prefer, request, state: view, connected: () => state.host === 'connected' };
}
