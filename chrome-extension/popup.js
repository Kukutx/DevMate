// The popup: how DevMate stands, and the few things this entry can do. Everything that decides something (what is
// shared, the permission profile, an agent's question) is done in the workbench it opens, not here.

const element = id => document.getElementById(id);
const ask = message => chrome.runtime.sendMessage(message);
const note = text => { element('note').textContent = text; };

function render({ state, settings }) {
  const runtime = state.runtime, running = runtime?.running === true, connected = state.host === 'connected';
  element('version').textContent = runtime?.version ? runtime.version : '';
  element('status').textContent = state.host === 'missing' ? 'Not set up on this computer'
    : !connected ? 'Connecting to DevMate…'
    : running ? 'DevMate is running' + (state.pending > 0 ? ' · ' + state.pending + ' waiting for you' : '')
    : 'DevMate is not running';
  const detail = element('detail');
  detail.className = state.host === 'missing' ? 'problem' : '';
  detail.replaceChildren();
  if (state.host === 'missing') detail.append('Register DevMate with this browser once, on this computer: ', Object.assign(document.createElement('code'), { textContent: 'devmate chrome install' }));
  else if (!connected && state.problem) detail.textContent = state.problem;
  else if (running) detail.textContent = 'This browser is available to it: bookmarks, tabs, history, downloads and the page in front.';
  element('start').hidden = !connected || running;
  element('workbench').disabled = !running;
  element('copy').disabled = !running;
  if (settings) element('autostart').checked = settings.startWithBrowser === true;
}

async function request(action) {
  const answer = await ask({ ask: 'request', action });
  if (!answer?.ok) throw new Error(answer?.error?.message || 'DevMate did not answer.');
  return answer.result;
}
const refresh = async () => render(await ask({ ask: 'state' }));

element('start').addEventListener('click', async () => {
  element('start').disabled = true; note('Starting…');
  try { await request('start'); note(''); } catch (error) { note(error.message); }
  element('start').disabled = false;
  await refresh();
});
element('workbench').addEventListener('click', async () => {
  try { const result = await request('workbench'); await chrome.tabs.create({ url: result.url }); window.close(); } catch (error) { note(error.message); }
});
element('copy').addEventListener('click', async () => {
  try { const result = await request('mcpUrl'); await navigator.clipboard.writeText(result.url); note('Copied.'); } catch (error) { note(error.message); }
});
element('autostart').addEventListener('change', async event => {
  await ask({ ask: 'settings', startWithBrowser: event.target.checked });
  note(event.target.checked ? 'DevMate will start when the browser does.' : 'DevMate will not be started by the browser.');
});
chrome.runtime.onMessage.addListener(message => { if (message?.kind === 'state') void refresh(); });
void refresh();
