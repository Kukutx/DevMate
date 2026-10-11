import { activityLine, copiedNote, describe, languageFor } from './panel.js';

// The panel: how DevMate and this browser stand, the one thing to do when something is in the way, the two switches
// that are the owner's, and what DevMate has been doing here. Everything that decides something about projects (what
// is shared, the permission profile, an agent's question) is done in the workbench it opens, not here.

const element = id => document.getElementById(id);
const ask = message => chrome.runtime.sendMessage(message);
const note = text => { element('note').textContent = text; };
const COMMANDS = { install: 'devmate chrome install', restart: 'devmate restart' };
let language = 'en', busy = false;

// A sentence with {install} or {restart} in it, with the command shown as something to copy.
function sentence(text) {
  const parts = document.createDocumentFragment();
  for (const piece of text.split(/(\{\w+\})/)) {
    const command = COMMANDS[piece.slice(1, -1)];
    parts.append(command && piece.startsWith('{') ? Object.assign(document.createElement('code'), { textContent: command }) : piece);
  }
  return parts;
}

function render({ state, settings, version }) {
  language = languageFor(settings.language, chrome.i18n?.getUILanguage?.() || navigator.language);
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  const view = describe(state, language), t = view.texts;
  element('version').textContent = state.runtime?.version || version || '';
  element('language').textContent = t.language;
  element('now').dataset.level = view.level;
  element('status').textContent = view.status;
  const detail = element('detail');
  detail.replaceChildren();
  if (view.text) { const line = document.createElement('p'); line.append(sentence(view.text)); detail.append(line); }
  if (view.steps) { const list = document.createElement('ol'); for (const step of view.steps) { const item = document.createElement('li'); item.append(sentence(step)); list.append(item); } detail.append(list); }
  if (view.said) {
    const said = Object.assign(document.createElement('div'), { className: 'said' });
    said.append(Object.assign(document.createElement('b'), { textContent: t.browserSaid }), view.said);
    detail.append(said);
  }
  element('debugging').hidden = !view.debugging;
  element('debuggingText').textContent = view.debugging || '';
  element('debugStop').textContent = view.labels.debugStop;
  for (const id of ['start', 'again']) { element(id).hidden = view.primary !== id; element(id).textContent = view.labels[id]; element(id).disabled = busy; }
  element('workbench').textContent = view.labels.workbench;
  element('workbench').disabled = !view.canOpen;
  element('workbench').classList.toggle('primary', view.canOpen && state.pending > 0);
  element('copy').textContent = view.labels.copy;
  element('copy').disabled = !view.canOpen;
  element('access').checked = settings.paused !== true;
  element('autostart').checked = settings.startWithBrowser === true;
  for (const id of ['accessTitle', 'accessText', 'autostartTitle', 'autostartText', 'activityTitle', 'none']) element(id).textContent = t[id];
  const list = element('activity');
  list.replaceChildren(...state.activity.map(entry => {
    const line = activityLine(entry, language), item = document.createElement('li');
    item.className = (line.change ? 'change ' : '') + (line.failed ? 'failed' : '');
    item.append(Object.assign(document.createElement('time'), { textContent: line.time }), Object.assign(document.createElement('span'), { className: 'name', textContent: line.name, title: line.name }),
      Object.assign(document.createElement('span'), { className: 'mark', textContent: line.mark }));
    return item;
  }));
  element('none').hidden = state.activity.length > 0;
  return view;
}

async function request(action) {
  const answer = await ask({ ask: 'request', action });
  if (!answer?.ok) throw new Error(answer?.error?.message || 'DevMate did not answer.');
  return answer.result;
}
const refresh = async () => render(await ask({ ask: 'state' }));
const texts = () => describe({ host: 'connecting', activity: [] }, language).texts;

element('start').addEventListener('click', async () => {
  busy = true; note(texts().starting); await refresh();
  try { await request('start'); note(''); } catch (error) { note(error.message); }
  busy = false; await refresh();
});
element('again').addEventListener('click', async () => { note(''); render(await ask({ ask: 'again' })); });
element('workbench').addEventListener('click', async () => {
  try { const result = await request('workbench'); await chrome.tabs.create({ url: result.url }); window.close(); } catch (error) { note(error.message); }
});
element('copy').addEventListener('click', async () => {
  try { const result = await request('mcpUrl'); await navigator.clipboard.writeText(result.url); note(copiedNote(result, language)); } catch (error) { note(error.message); }
});
element('debugStop').addEventListener('click', async () => render(await ask({ ask: 'debugStop' })));
element('access').addEventListener('change', async event => render(await ask({ ask: 'pause', paused: !event.target.checked })));
element('autostart').addEventListener('change', async event => render(await ask({ ask: 'settings', startWithBrowser: event.target.checked })));
element('language').addEventListener('click', async () => render(await ask({ ask: 'settings', language: language === 'zh' ? 'en' : 'zh' })));
chrome.runtime.onMessage.addListener(message => { if (message?.kind === 'state') void refresh(); });
void refresh();
