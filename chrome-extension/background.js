import { createCapabilities } from './capabilities.js';
import { createBridge } from './bridge.js';

// The extension's background: it keeps the connection to DevMate open for as long as the browser runs, answers what
// the runtime asks of the browser, and tells the popup how things stand. Chrome keeps this worker alive while the
// native connection is open; an alarm brings the connection back after the worker was put to sleep without one.

const version = chrome.runtime.getManifest().version;
const browser = globalThis.navigator?.userAgentData?.brands?.find(item => !/not.?a.?brand/i.test(item.brand))?.brand || 'Chromium';
const settings = {
  get: async () => ({ startWithBrowser: false, ...(await chrome.storage.local.get(['startWithBrowser'])) }),
  set: values => chrome.storage.local.set(values)
};

function show(state) {
  // What waits for the owner is a number on the icon; a host that is not registered is a mark of its own.
  const text = state.host === 'missing' ? '!' : state.pending > 0 ? String(Math.min(state.pending, 99)) : '';
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state.host === 'missing' ? '#b3261e' : '#1f6feb' }).catch(() => {});
  chrome.runtime.sendMessage({ kind: 'state', state }).catch(() => {});
}

const bridge = createBridge({
  // Chrome reports why a connection ended in runtime.lastError, readable only inside the disconnect listener.
  connect: name => {
    const port = chrome.runtime.connectNative(name);
    return { postMessage: message => port.postMessage(message), onMessage: port.onMessage,
      onDisconnect: { addListener: listener => port.onDisconnect.addListener(() => listener(chrome.runtime.lastError?.message || '')) } };
  },
  methods: createCapabilities(chrome, { version }), version, browser, settings, onChange: show
});

chrome.runtime.onStartup.addListener(() => bridge.open());
chrome.runtime.onInstalled.addListener(() => bridge.open());
chrome.alarms.create('devmate-connection', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'devmate-connection' && !bridge.connected()) bridge.open(); });
bridge.open();

// The popup asks; only these three questions are answered.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false;
  if (message.ask === 'state') { settings.get().then(saved => respond({ state: bridge.state(), settings: saved })); return true; }
  if (message.ask === 'settings') { settings.set({ startWithBrowser: message.startWithBrowser === true }).then(() => respond({ ok: true })); return true; }
  if (message.ask === 'request') {
    bridge.request(message.action).then(result => respond({ ok: true, result }), error => respond({ ok: false, error: { code: error.code || 'failed', message: error.message } }));
    return true;
  }
  return false;
});
