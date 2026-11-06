import { createCapabilities } from './capabilities.js';
import { createBridge } from './bridge.js';
import { createRenewal } from './renew.js';

// The extension's background: it keeps the connection to DevMate open for as long as the browser runs, answers what
// the runtime asks of the browser, and tells the panel how things stand. Chrome keeps this worker alive while the
// native connection is open; an alarm brings the connection back after the worker was put to sleep without one.

const version = chrome.runtime.getManifest().version;
const browser = globalThis.navigator?.userAgentData?.brands?.find(item => !/not.?a.?brand|chromium/i.test(item.brand))?.brand || 'Chromium';
const DEFAULTS = { startWithBrowser: false, paused: false, language: '' };
const settings = {
  get: async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) }),
  set: values => chrome.storage.local.set(values)
};

function show(state) {
  // On the icon: what waits for the owner as a number, a pause as "II", a problem as "!".
  const problem = state.host === 'missing' || (state.host === 'closed' && state.attempts > 2);
  const text = problem ? '!' : state.paused ? 'II' : state.pending > 0 ? String(Math.min(state.pending, 99)) : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: problem ? '#b3261e' : state.paused ? '#7a7a7a' : '#18181b' }).catch(() => {});
  chrome.runtime.sendMessage({ kind: 'state' }).catch(() => {});
}

// The tabs that have the debugger on them right now, for the panel.
let debugging = [];
// ownPort: the local port DevMate answers the owner on, as the bridge last heard it (see own() in capabilities.js).
const methods = createCapabilities(chrome, { version, onChange: tabs => { debugging = tabs; chrome.runtime.sendMessage({ kind: 'state' }).catch(() => {}); },
  ownPort: () => bridge.state().runtime?.port, paused: async () => (await settings.get()).paused === true });
const letGo = () => methods['page.debugStop']({}).catch(() => {});

const bridge = createBridge({
  // Chrome reports why a connection ended in runtime.lastError, readable only inside the disconnect listener.
  connect: name => {
    const port = chrome.runtime.connectNative(name);
    return { postMessage: message => port.postMessage(message), disconnect: () => port.disconnect(), onMessage: port.onMessage,
      onDisconnect: { addListener: listener => port.onDisconnect.addListener(() => listener(chrome.runtime.lastError?.message || '')) } };
  },
  methods, version, browser, settings, onChange: show
});

// After an update of DevMate the files on disk are newer than what the browser runs: see renew.js.
const renewal = createRenewal({ read: name => fetch(chrome.runtime.getURL(name), { cache: 'no-store' }).then(response => response.text()), storage: chrome.storage.local, reload: () => chrome.runtime.reload() });

// A debugger left on a tab by a worker that was put to sleep is taken off: nothing here remembers it any more. That
// comes first, so that it cannot take off one DevMate has just asked for.
const tidy = Promise.resolve().then(() => chrome.debugger.getTargets()).then(targets => Promise.all(targets.filter(one => one.attached && one.tabId !== undefined).map(one => chrome.debugger.detach({ tabId: one.tabId }).catch(() => {})))).catch(() => {});
const open = () => tidy.then(() => bridge.open());

chrome.runtime.onStartup.addListener(open);
chrome.runtime.onInstalled.addListener(() => { void open(); void renewal.loaded(); });
chrome.alarms.create('devmate-connection', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== 'devmate-connection') return;
  // Not connected: try again. Connected: see that the host still answers (bridge.look).
  void tidy.then(() => { if (!bridge.connected()) bridge.again(); else void bridge.look(); });
  void renewal.look();
});
void open();

// The panel asks; these questions are answered and no others.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  const whole = async () => ({ state: { ...bridge.state(), debugging: debugging.length }, settings: await settings.get(), version, browser });
  if (message.ask === 'state') { whole().then(respond); return true; }
  if (message.ask === 'again') { bridge.again(); whole().then(respond); return true; }
  // A browser the owner wants to themselves has no debugger left on its tabs either.
  if (message.ask === 'pause') { bridge.pause(message.paused === true).then(() => message.paused === true ? letGo() : null).then(whole).then(respond); return true; }
  if (message.ask === 'debugStop') { letGo().then(whole).then(respond); return true; }
  if (message.ask === 'settings') {
    const wanted = {};
    if (typeof message.startWithBrowser === 'boolean') wanted.startWithBrowser = message.startWithBrowser;
    if (['', 'en', 'zh'].includes(message.language)) wanted.language = message.language;
    settings.set(wanted).then(whole).then(respond);
    return true;
  }
  if (message.ask === 'request') {
    (message.action === 'prefer' ? bridge.prefer() : bridge.request(message.action)).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: { code: error.code || 'failed', message: error.message } }));
    return true;
  }
  return false;
});
