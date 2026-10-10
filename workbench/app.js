(() => {
'use strict';
const $ = id => document.getElementById(id);
const root = document.documentElement;
const PAGE = 50;
const TABS = ['Overview', 'Approvals', 'Agents', 'Activity', 'Messages', 'Tasks', 'Files', 'Changes', 'Commands', 'Problems', 'Artifacts'];
// views holds one state object per tab: its loaded data and everything the person typed there.
const state = {snapshot: {}, projectId: '', workflowId: '', tab: 'Overview', generation: 0, views: {}, references: [],
  projectResults: null, query: '', disposed: false, expired: false};
const views = {};
let bridge, feed = null, feedLost = false, refreshTimer = null, lastRefresh = 0, referenceQueue = Promise.resolve();

// ---------- DOM ----------
// Handlers live in a table on the node, so a re-render can replace a handler without replacing the node.
function listen(node, type, handler) {
  if (!node._on) node._on = {};
  if (!(type in node._on)) node.addEventListener(type, event => node._on[type]?.(event));
  node._on[type] = handler;
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || key === 'value') continue;
    if (key.startsWith('on')) listen(node, key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (['disabled', 'checked', 'readOnly', 'hidden'].includes(key)) node[key] = !!value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
    .map(child => typeof child === 'string' ? document.createTextNode(child) : child));
  // After the children, so a select can find the option it is set to.
  if (props.value !== undefined && props.value !== null) node.value = props.value;
  return node;
}
const isField = node => node.nodeName === 'INPUT' || node.nodeName === 'TEXTAREA' || node.nodeName === 'SELECT';
const fieldValue = node => node.type === 'checkbox' ? node.checked : node.value;
const keyOf = node => node.nodeType === 1 ? node.getAttribute('data-key') : null;
const alike = (a, b) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && keyOf(a) === keyOf(b) && a.type === b.type;
// Make `live` look like `next` while keeping the nodes the person is using. A control that already
// shows the wanted value is never written to, so focus, caret, selection and IME input survive.
function morph(live, next) {
  if (live.nodeType !== 1) { if (live.data !== next.data) live.data = next.data; return; }
  const wanted = isField(next) ? fieldValue(next) : null;
  for (const {name: attribute} of [...live.attributes]) {
    // A control whose action is still running stays marked busy until that action ends.
    if (!next.hasAttribute(attribute) && !(live._busy && BUSY.includes(attribute))) live.removeAttribute(attribute);
  }
  for (const {name: attribute, value} of [...next.attributes]) if (live.getAttribute(attribute) !== value) live.setAttribute(attribute, value);
  for (const type of Object.keys(live._on || {})) if (!next._on?.[type]) live._on[type] = null;
  for (const [type, handler] of Object.entries(next._on || {})) listen(live, type, handler);
  morphChildren(live, next);
  if (wanted !== null && fieldValue(live) !== wanted) { if (live.type === 'checkbox') live.checked = wanted; else live.value = wanted; }
}
// Children match by data-key when they have one (list rows), otherwise by position and element type.
function morphChildren(live, next) {
  const keyed = new Map();
  for (const child of live.children) { const key = keyOf(child); if (key !== null) keyed.set(key, child); }
  let cursor = live.firstChild;
  for (const child of [...next.childNodes]) {
    const key = keyOf(child), candidate = key !== null ? keyed.get(key) : cursor;
    if (candidate && alike(candidate, child)) {
      if (key !== null) keyed.delete(key);
      if (candidate === cursor) cursor = cursor.nextSibling; else live.insertBefore(candidate, cursor);
      morph(candidate, child);
    } else live.insertBefore(child, cursor);
  }
  while (cursor) { const stale = cursor; cursor = cursor.nextSibling; live.removeChild(stale); }
}
// Run a control's action once at a time. Until its own action has ended the control ignores further
// presses and is announced as busy and unavailable; it stays focusable, so the focus is not lost meanwhile.
const BUSY = ['aria-busy', 'aria-disabled'];
function act(node, action, event) {
  if (node._busy) return;
  let result;
  try { result = action(event); } catch (error) { fail(error); return; }
  if (!result || typeof result.then !== 'function') return;
  node._busy = true;
  for (const attribute of BUSY) node.setAttribute(attribute, 'true');
  result.catch(fail).finally(() => { node._busy = false; for (const attribute of BUSY) node.removeAttribute(attribute); });
}
const button = (text, action, props = {}) => el('button', {type: 'button', text, onclick: event => act(event.currentTarget, action, event), ...props});
// Enter in a field of the same form clicks this button, also where a sandboxed frame blocks form submission.
const submitButton = (text, action, props = {}) => el('button', {type: 'submit', text,
  onclick: event => { event.preventDefault(); act(event.currentTarget, action, event); }, ...props});
const form = (props, ...children) => el('form', {novalidate: '', onsubmit: event => event.preventDefault(), ...props}, ...children);

// ---------- small pieces ----------
const str = value => typeof value === 'string' ? value : '';
function name(value) { return str(value?.name) || str(value?.title) || str(value?.label) || str(value?.id); }
function date(value) { return value ? new Date(value).toLocaleString() : ''; }
function time(value) { return value ? new Date(value).toLocaleTimeString() : ''; }
const label = (text, control, hint) => el('label', {}, text, control, hint ? el('span', {class: 'hint', text: hint}) : null);
const TONES = {ok: ['completed', 'delivered', 'resolved', 'ready', 'exited', 'ok', 'installed', 'active', 'Trusted'],
  warn: ['pending', 'waiting', 'queued', 'running', 'starting', 'cancelling', 'warn', 'warning', 'paused', 'unknown', 'stopped', 'cancelled'],
  error: ['failed', 'error', 'fail', 'unavailable', 'disconnected', 'timed_out', 'expired', 'Untrusted']};
const tone = status => Object.keys(TONES).find(key => TONES[key].includes(status)) || '';
const badge = (text, kind = tone(text)) => el('span', {class: 'badge ' + kind, text: text || 'unknown'});
const caption = text => el('p', {class: 'caption', text});
const heading = (title, ...actions) => el('div', {class: 'toolbar'}, el('h2', {text: title}), ...actions);
const subheading = (title, ...actions) => el('div', {class: 'toolbar'}, el('h3', {text: title}), ...actions);
const empty = (title, text, actions = []) => el('div', {class: 'empty'}, el('h2', {text: title}), el('p', {text}), ...actions);
const pre = (text, props = {}) => el('pre', {class: 'preview', tabindex: '0', ...props, text});
const fact = (term, text) => text ? [el('dt', {text: term}), el('dd', {text})] : [];
function required(value, what) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('Enter ' + what + '.');
  return text;
}
// Every control is bound to a plain object: a view's own state, or the draft of the dialog it is in.
function bind(holder, key, {fallback = '', changed} = {}) {
  return {value: holder[key] ?? fallback, oninput: event => { holder[key] = event.target.value; changed?.(event); }};
}
const input = (holder, key, props = {}, options) => el('input', {type: 'text', ...props, ...bind(holder, key, options)});
const textarea = (holder, key, props = {}, options) => el('textarea', {...props, ...bind(holder, key, options)});
function select(holder, key, list, placeholder, props = {}, {fallback = '', changed} = {}) {
  return el('select', {...props, value: holder[key] ?? fallback, onchange: event => { holder[key] = event.target.value; changed?.(event); }},
    placeholder === null ? null : el('option', {value: '', text: placeholder}), list.map(item => el('option', {value: item.id, text: name(item)})));
}
function checkbox(holder, key, props = {}, {fallback = false, changed} = {}) {
  return el('input', {type: 'checkbox', ...props, checked: holder[key] ?? fallback, onchange: event => { holder[key] = event.target.checked; changed?.(event); }});
}

// ---------- messages to the person ----------
function notice(text = '') { $('alert').hidden = true; $('alert-text').textContent = ''; $('notice').textContent = text; }
function fail(error) {
  if (error?.code === 'session_expired') return; // the reload banner already says what to do
  $('notice').textContent = ''; $('alert-text').textContent = error?.message || String(error); $('alert').hidden = false;
}
function setConnection(text, problem = false) { const node = $('connection'); node.textContent = text; node.className = problem ? 'badge error' : 'badge ok'; }
const connectedText = () => 'Connected · ' + (bridge.embedded ? bridge.hostName || 'chat app' : 'local');
// The local page is signed in, per tab, to one running DevMate. A tab that was never signed in, or whose DevMate was
// restarted, can load and save nothing until the workbench is opened again from a place only its owner can reach.
function expire() {
  if (state.expired) return;
  state.expired = true; feed?.abort(); feed = null;
  $('session-text').textContent = bridge.session
    ? 'DevMate was restarted or this page was signed out, so it can no longer load or save anything. ' +
      'Open the workbench again from your editor (DevMate: Open Workbench) or by running “devmate ui”: this page cannot sign itself in. What you typed is still here to copy; reloading discards it.'
    : 'This tab is not signed in to DevMate. The workbench opens from a place only you can reach on this computer: run “devmate ui” in a terminal, ' +
      'or use DevMate: Open Workbench in VS Code or Obsidian. 工作台需要从本机入口打开：在终端运行 “devmate ui”，或在 VS Code / Obsidian 中执行 “DevMate: Open Workbench”。';
  $('session').hidden = false; setConnection('Signed out', true);
  for (const id of ['confirm', 'dialog']) if ($(id).open) $(id).close();
  $('session-reload').focus();
}

// ---------- dialogs ----------
function showModal(node) {
  node._opener = document.activeElement; node.showModal();
  // A host that sizes the frame to its content shows only part of it. A dialog centred in the whole frame can
  // then be thousands of pixels from the button that opened it, so it is placed beside that button instead.
  if (bridge?.embedded && bridge.displayMode !== 'fullscreen' && node._opener?.getBoundingClientRect) {
    const top = node._opener.getBoundingClientRect().top + scrollY;
    Object.assign(node.style, { position: 'absolute', margin: '0 auto', top: Math.max(8, Math.min(top - 40, document.documentElement.scrollHeight - node.offsetHeight - 8)) + 'px' });
  } else Object.assign(node.style, { position: '', margin: '', top: '' });
}
// Focus returns to the control that opened the dialog, or to the workspace when that control is gone.
function closed(node) {
  const opener = node._opener, settle = node._settle;
  node._opener = null; node._owner = null; node._settle = null;
  settle?.();
  if (state.expired) $('session-reload').focus();
  else (opener?.isConnected && !opener.disabled ? opener : $('main')).focus();
}
// submit throws to keep the dialog open with its message; the dialog closes only after its own submit succeeded.
function dialog(title, fields, submitLabel, submit) {
  const node = $('dialog'), owner = {};
  $('dialog-title').textContent = title; $('dialog-error').textContent = '';
  $('dialog-body').replaceChildren(...fields.flat(Infinity).filter(Boolean));
  const send = async () => {
    $('dialog-error').textContent = '';
    try { if (await submit() === false) return; }
    catch (error) {
      if (node._owner !== owner) throw error; // closed meanwhile: the page reports it
      $('dialog-error').textContent = error.message; return;
    }
    if (node._owner === owner) node.close();
  };
  $('dialog-actions').replaceChildren(button(submit ? 'Cancel' : 'Close', () => node.close()),
    ...(submit ? [submitButton(submitLabel, send, {class: 'primary'})] : []));
  $('dialog-body').querySelector('input,textarea,select')?.setAttribute('autofocus', '');
  if (!node.open) showModal(node);
  node._owner = owner;
}
// An in-page question: the browser's own confirmation box is silently answered with "no" inside a sandboxed host.
function confirmAction(title, text, action) {
  const node = $('confirm');
  if (node.open) return Promise.resolve(false);
  return new Promise(resolve => {
    let answer = false;
    $('confirm-title').textContent = title; $('confirm-text').textContent = text;
    $('confirm-actions').replaceChildren(button('Cancel', () => node.close()),
      el('button', {type: 'submit', class: 'primary danger', text: action, onclick: event => { event.preventDefault(); answer = true; node.close(); }}));
    node._settle = () => resolve(answer);
    showModal(node);
  });
}

// ---------- calls ----------
const scope = () => ({...(state.projectId ? {projectId: state.projectId} : {}), ...(state.workflowId ? {workflowId: state.workflowId} : {})});
const can = operation => !Array.isArray(state.snapshot.capabilities?.operations) || state.snapshot.capabilities.operations.includes(operation);
const opButton = (text, operation, action, props = {}) => button(text, action, {...props, disabled: !!props.disabled || !can(operation)});
const selectedProject = () => (state.snapshot.projects || []).find(item => item.id === state.projectId);
const selectedWorkflow = () => (state.snapshot.workflows || []).find(item => item.id === state.workflowId);
const projectWritable = () => selectedProject()?.access !== 'read';
// Agent labels from every list that was loaded, so a request or turn can name its agent whichever page that agent is on.
const labels = new Map();
const remember = list => { for (const agent of list || []) if (agent?.id && name(agent)) labels.set(agent.id, name(agent)); };
const agentName = id => labels.get(id) || id || 'agent';
async function call(operation, data = {}) {
  try {
    const result = await bridge.call(operation, data);
    if (operation === 'agents.list' || operation === 'workbench.snapshot') remember(result?.items || result?.agents);
    return result;
  } catch (error) { if (error.code === 'session_expired') expire(); throw error; }
}
// Each change is its own request with its own receipt. None waits on, replaces or cancels another.
async function mutate(operation, data = {}, done = 'Done.') {
  let result;
  try { result = await call(operation, {...data, operationId: crypto.randomUUID()}); }
  catch (error) {
    if (error.code === 'unreachable') error.message += ' The change may or may not have been applied: refresh and check before trying again.';
    throw error;
  }
  notice(done); void refresh();
  return result;
}
// A panel's data, its error and its newest request belong together, so a slow or failing panel
// never blanks or overwrites another, and an answer for an earlier project or workflow is dropped.
function source(fetch) { return {data: null, error: null, ticket: 0, paging: false, fetch}; }
async function pull(src, more = false) {
  if (src.paging && !more) return false; // "Load more" in flight is not overtaken by a background refresh
  const ticket = ++src.ticket, generation = state.generation, newest = () => ticket === src.ticket && generation === state.generation;
  src.paging = more;
  try { const data = await src.fetch(more); if (newest()) { src.data = data; src.error = null; } }
  catch (error) { if (newest()) src.error = error; }
  finally { if (ticket === src.ticket) src.paging = false; }
  return newest();
}
// A refresh asks again for as many rows as are on screen, so pages already loaded stay loaded.
function paged(operation, params, size = PAGE) {
  const src = source(async more => {
    const have = src.data?.items || [];
    const result = await call(operation, {...params(), limit: more ? size : Math.min(Math.max(have.length, size), 1000),
      ...(more && src.data?.nextCursor ? {cursor: src.data.nextCursor} : {})});
    return {items: more ? [...have, ...(result.items || [])] : result.items || [], nextCursor: result.nextCursor || null};
  });
  return src;
}
async function everything(operation, params) {
  const all = [];
  let cursor;
  do {
    const page = await call(operation, {...params, limit: 200, ...(cursor ? {cursor} : {})});
    all.push(...(page.items || [])); cursor = page.nextCursor;
  } while (cursor && all.length < 5000);
  return {items: all};
}
const items = src => src.data?.items || [];
const repaint = () => renderMain();
// What a panel shows in place of content: that it is loading, or why it could not load.
function pending(src, what) {
  if (src.error) return el('div', {class: 'problem'}, el('p', {class: 'error-text', role: 'alert', text: 'Could not load ' + what + ': ' + src.error.message}),
    button('Try again', () => pull(src).then(repaint)));
  return src.data ? null : caption('Loading ' + what + '…');
}
const more = src => src.data?.nextCursor ? button('Load more', () => pull(src, true).then(repaint)) : null;
function describe(event) {
  const native = event.nativeEvent, entity = event.entity || {};
  if (event.type === 'agent.native') return 'Agent ' + (str(native?.nativeMethod) || str(native?.type) || 'event') + (str(native?.state) ? ' · ' + native.state : '');
  const subject = str(entity.name) || str(entity.title) || str(entity.label) || (entity.agentId ? agentName(entity.agentId) : '') || str(event.path) || str(event.command);
  return [String(event.type || 'activity').replaceAll('.', ' '), subject, str(entity.status) || str(event.status)].filter(Boolean).join(' · ');
}

// ---------- overview ----------
views.Overview = {
  scope: 'project',
  create: () => ({draft: {},
    summary: source(() => call('project.overview', {projectId: state.projectId})),
    connection: source(() => call('connection.status', {})),
    doctor: source(() => call('runtime.doctor', {}))}),
  load: v => Promise.all([pull(v.connection), state.projectId ? pull(v.summary) : null]),
  render: overview
};
const metric = (title, value, tab, note) => el('button', {type: 'button', class: 'card', onclick: () => changeTab(tab)},
  el('span', {class: 'card-title', text: title}), el('span', {class: 'metric', text: String(value ?? '—')}), note ? el('span', {class: 'card-title', text: note}) : null);
function overview(v) {
  if (!state.projectId) return [empty('Your projects, together', 'Choose a project to look at its files, follow its agents and answer their questions.',
    [opButton('Add project', 'project.create', createProject, {class: 'primary'})]), editorWindows(), connectionPanel(v)];
  const project = selectedProject() || {id: state.projectId}, flow = selectedWorkflow(), snapshot = state.snapshot, counts = snapshot.counts || {};
  const summary = v.summary.data || {}, editor = summary.editor, activity = (snapshot.activity || []).slice(-20).reverse();
  return [
    heading(name(flow || project) || 'Project', opButton('New workflow', 'workflow.create', createWorkflow), opButton('Add project', 'project.create', createProject)),
    el('div', {class: 'cards'},
      metric('Waiting for you', counts.pendingReviews ?? 0, 'Approvals'),
      metric('Agents', counts.agents ?? (snapshot.agents || []).length, 'Agents'),
      metric('Active tasks', counts.activeTasks ?? (snapshot.tasks || []).length, 'Tasks'),
      metric('Artifacts', counts.artifacts ?? (snapshot.artifacts || []).length, 'Artifacts'),
      metric('Editor errors', editor?.attachedWindows ? editor.error : '—', 'Problems', editor?.attachedWindows ? editor.warning + (editor.warning === 1 ? ' warning' : ' warnings') : 'No editor attached'),
      metric('Changed files', summary.git ? summary.git.changedFiles : '—', 'Changes', summary.git ? 'Branch ' + (summary.git.branch || 'detached') : 'No Git information')),
    el('section', {class: 'panel'}, el('h3', {text: flow ? 'Workflow context' : 'Project context'}),
      el('p', {text: str(flow?.description) || str(project.description) || 'Start or select a workflow to keep messages, tasks and results together.'}),
      caption([project.root || project.id, (summary.markers || []).join(', ')].filter(Boolean).join(' · ')),
      v.summary.error ? el('p', {class: 'error-text', text: 'Could not read the project summary: ' + v.summary.error.message}) : null),
    flow ? el('section', {class: 'panel'}, subheading('Workflow', badge(flow.status), opButton('Edit workflow', 'workflow.update', () => editWorkflow(flow)),
      opButton('Close', 'workflow.update', () => mutate('workflow.update', {id: flow.id, status: 'completed', expectedRevision: flow.revision}, 'Workflow closed.'), {disabled: flow.status === 'completed'})),
      caption('Turns used: ' + (flow.usedTurns || 0) + ' of ' + (flow.turnBudget ?? '—'))) : null,
    projectSettings(v, project), connectionPanel(v), editorWindows(),
    el('section', {class: 'panel'}, subheading('Recent activity', button('Open activity', () => changeTab('Activity'))),
      activity.map(event => el('div', {class: 'entry', 'data-key': String(event.sequence)}, el('span', {class: 'caption', text: date(event.createdAt)}), el('p', {text: describe(event)}))),
      activity.length ? null : caption('Nothing has happened in this project recently.'))
  ];
}
function projectSettings(v, project) {
  const save = async () => {
    const draft = v.draft, patch = {};
    if (draft.name !== undefined && draft.name.trim() !== project.name) patch.name = required(draft.name, 'a project name');
    if (draft.access !== undefined && draft.access !== (project.access || 'write')) patch.access = draft.access;
    if (draft.protectSecrets !== undefined && draft.protectSecrets !== (project.protectSecrets !== false)) patch.protectSecrets = draft.protectSecrets;
    if (!Object.keys(patch).length) { notice('Nothing to save: the settings are unchanged.'); return; }
    if (patch.access === 'write' && !await confirmAction('Let AI clients change this project?', 'Connected assistants and agents will be able to change files and run commands in ' + project.root + '.', 'Allow changes')) return;
    if (patch.access === 'read' && !await confirmAction('Make this project read only?', 'Commands and jobs that are running in this project are stopped first. Agents must already be stopped.', 'Make read only')) return;
    if (patch.protectSecrets === false && !await confirmAction('Stop protecting credential files?', 'Files such as .env, private keys and .npmrc become readable and editable here and for every connected assistant and agent.', 'Stop protecting')) return;
    const saved = await mutate('project.update', {id: project.id, ...patch, expectedRevision: project.revision}, 'Project settings saved.');
    // Emptied in place: the controls on screen stay bound to this same object.
    for (const key of Object.keys(patch)) delete draft[key];
    // The answer is the project as it is now; the next save must start from it, not from the last refresh.
    const known = state.snapshot.projects || [], index = known.findIndex(item => item.id === saved?.id);
    if (index >= 0) { known[index] = saved; renderSelectors(); renderMain(); }
  };
  const remove = async () => {
    if (!await confirmAction('Remove ' + (project.name || 'this project') + '?', 'DevMate forgets this project and its workflows, tasks, messages and history. The files on disk are not touched.', 'Remove project')) return;
    await mutate('project.remove', {id: project.id}, 'Project removed.');
    await changeScope('', '', true);
  };
  return el('section', {class: 'panel stack'}, el('h3', {text: 'Project settings'}),
    label('Project name', input(v.draft, 'name', {}, {fallback: project.name})),
    label('What assistants and agents may do', select(v.draft, 'access', [{id: 'write', name: 'Read and change files, run commands'}, {id: 'read', name: 'Read only'}], null, {}, {fallback: project.access || 'write'}),
      'Read only lets them look at files and Git but not change anything, run commands or start agents.'),
    el('label', {class: 'check'}, checkbox(v.draft, 'protectSecrets', {}, {fallback: project.protectSecrets !== false}), 'Protect credential files'),
    el('p', {class: 'hint', text: 'While protection is on, files that usually hold passwords and keys (for example .env files, private key files and .npmrc) do not appear in the file list or in search, ' +
      'cannot be opened, changed or deleted here or by connected assistants, and are left out of Git diffs. Git status still names them, marked as protected, so they are not committed by accident. ' +
      'Commands that are run in the project are not restricted by this setting.'}),
    state.snapshot.access?.profile === 'full' ? el('p', {class: 'hint', text: 'Full access is switched on, so this protection is not applied to any project right now. It applies again with the guarded profile (devmate access guarded).'}) : null,
    el('div', {class: 'actions'}, opButton('Save settings', 'project.update', save, {class: 'primary'}), opButton('Remove project', 'project.remove', remove, {class: 'danger'})));
}
function connectionPanel(v) {
  const status = v.connection.data, doctor = v.doctor, local = !bridge.embedded && can('runtime.doctor');
  const route = !status ? '' : status.remoteMcpVerified ? 'Verified: a test connection through the public address reached this DevMate.'
    : status.kind === 'local' ? 'None. Only apps on this computer can connect.'
    : 'Not verified yet' + (str(status.verification?.reason) ? ': ' + status.verification.reason : '.');
  return el('section', {class: 'panel'}, subheading('Connection', local ? button('Run doctor', () => pull(doctor).then(repaint)) : null),
    pending(v.connection, 'the connection state'),
    status ? el('dl', {class: 'facts'}, fact('Kind', str(status.kind) || 'local'), fact('State', str(status.phase) || str(status.status) || 'unknown'), fact('Public route', route),
      fact('Problem', str(status.error?.message))) : null,
    doctor.error ? el('p', {class: 'error-text', role: 'alert', text: 'The check could not run: ' + doctor.error.message}) : null,
    doctor.data ? el('div', {class: 'stack'}, el('h4', {text: 'Doctor: ' + (doctor.data.status === 'ok' ? 'everything needed is in place' : doctor.data.status === 'warn' ? 'works, with warnings' : 'something needs fixing')}),
      (doctor.data.checks || []).map(check => el('div', {class: 'entry', 'data-key': check.id}, el('div', {class: 'row-head'}, el('strong', {text: check.id}), badge(check.status)),
        el('p', {text: check.detail}), check.fix && check.status !== 'ok' ? el('p', {class: 'hint', text: 'What to do: ' + check.fix}) : null))) : null);
}
function editorWindows() {
  const windows = state.snapshot.windows || [];
  if (!windows.length) return null;
  return el('section', {class: 'panel'}, el('h3', {text: 'Connected editor windows'}),
    windows.map(window => el('div', {class: 'item', 'data-key': window.windowId}, el('div', {class: 'row-head'}, el('strong', {text: window.title || 'VS Code'}), badge(window.trusted ? 'Trusted' : 'Untrusted')),
      (window.roots || []).map(folder => el('div', {class: 'row-head'}, opButton(folder.name, 'project.list', () => changeScope(folder.projectId, ''), {disabled: !folder.projectId}),
        caption(folder.projectId === window.selectedProjectId ? 'Selected in this editor window' : folder.root))))));
}
function createProject() {
  const draft = {name: '', root: ''};
  dialog('Add project', [label('Name', input(draft, 'name')), label('Folder on this DevMate computer', input(draft, 'root', {placeholder: 'An absolute path'}))], 'Add project', async () => {
    const project = await mutate('project.create', {name: required(draft.name, 'a name'), root: required(draft.root, 'the folder path')}, 'Project added.');
    if (project?.id) void changeScope(project.id, '');
  });
}
function createWorkflow() {
  if (!state.projectId) return;
  const draft = {title: '', budget: '40'};
  dialog('New workflow', [label('Title', input(draft, 'title')), label('Agent turn budget', input(draft, 'budget', {type: 'number', min: '1', max: '10000'}))], 'Create', async () => {
    const workflow = await mutate('workflow.create', {projectId: state.projectId, title: required(draft.title, 'a title'), turnBudget: turns(draft.budget)}, 'Workflow created.');
    if (workflow?.id) void changeScope(state.projectId, workflow.id);
  });
}
function turns(value) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Enter a turn budget between 1 and 10000.');
  return count;
}
function editWorkflow(flow) {
  const draft = {title: flow.title, status: flow.status, budget: String(flow.turnBudget ?? 40)};
  dialog('Edit workflow', [label('Title', input(draft, 'title')), label('Status', select(draft, 'status', ['active', 'paused', 'completed'].map(id => ({id, name: id})), null)),
    label('Agent turn budget', input(draft, 'budget', {type: 'number', min: '1', max: '10000'}))], 'Save', () =>
    mutate('workflow.update', {id: flow.id, title: required(draft.title, 'a title'), status: draft.status, turnBudget: turns(draft.budget), expectedRevision: flow.revision}, 'Workflow saved.'));
}

// ---------- approvals and questions ----------
// An agent is blocked until the person answers, so everything pending in the project is always loaded in full and shown first.
views.Approvals = {
  scope: 'project',
  create: () => ({answers: {},
    approvals: source(() => everything('approval.list', {projectId: state.projectId, status: 'pending', newestFirst: true})),
    inputs: source(() => everything('input.list', {projectId: state.projectId, status: 'pending', newestFirst: true})),
    pastApprovals: paged('approval.list', () => ({...scope(), newestFirst: true})),
    pastInputs: paged('input.list', () => ({...scope(), newestFirst: true}))}),
  load: v => Promise.all([pull(v.approvals), pull(v.inputs), pull(v.pastApprovals), pull(v.pastInputs)]),
  render: approvalsView
};
function approvalsView(v) {
  const waiting = src => items(src).filter(item => item.status === 'pending'), answered = src => items(src).filter(item => item.status !== 'pending');
  const approvals = waiting(v.approvals), inputs = waiting(v.inputs), past = [...answered(v.pastApprovals), ...answered(v.pastInputs)];
  return [heading('Approvals and questions'), pending(v.approvals, 'approval requests'), pending(v.inputs, 'questions'),
    v.approvals.data && v.inputs.data && !approvals.length && !inputs.length ? empty('Nothing is waiting for you', 'When an agent needs permission or an answer, it appears here and the agent waits.') : null,
    approvals.map(approval => approvalCard(approval)), inputs.map(request => inputRequest(v, request)),
    el('section', {class: 'panel'}, el('h3', {text: 'Already answered'}), pending(v.pastApprovals, 'earlier approvals'), pending(v.pastInputs, 'earlier questions'),
      past.map(item => el('div', {class: 'entry', 'data-key': item.id}, el('div', {class: 'row-head'}, el('strong', {text: requestTitle(item)}), badge(item.status)),
        caption([agentName(item.agentId), date(item.updatedAt || item.createdAt)].filter(Boolean).join(' · ')))),
      past.length ? null : caption('No earlier requests in this view.'), more(v.pastApprovals), more(v.pastInputs))];
}
// Answers to an agent are the person's own and are given at their computer, never through a connected client.
const ANSWER_LOCALLY = 'Answer this on your computer: in your editor, or in the local workbench (run “devmate ui”).';
const requestTitle = item => str(item.prompt) || str(item.question) || str(item.details?.message) || str(item.summary) || str(item.title) || 'Request from an agent';
function approvalCard(approval) {
  const options = Array.isArray(approval.options) ? approval.options : [];
  // Once the decision is accepted the request leaves the waiting list at once, not with the next refresh.
  const decide = async optionId => { await mutate('approval.resolve', {id: approval.id, optionId, expectedRevision: approval.revision}, 'Decision sent.'); approval.status = 'resolved'; renderMain(); };
  return el('div', {class: 'item waiting', 'data-key': approval.id}, el('div', {class: 'row-head'}, el('h3', {text: str(approval.summary) || str(approval.title) || 'Approval request'}), badge(approval.status)),
    caption([agentName(approval.agentId), str(approval.provider), str(approval.risk), date(approval.createdAt), approval.automatic ? 'granted automatically (full access)' : ''].filter(Boolean).join(' · ')),
    approval.details ? pre(typeof approval.details === 'string' ? approval.details : JSON.stringify(approval.details, null, 2), {'aria-label': 'What is being asked'}) : null,
    el('div', {class: 'actions'}, options.map(option => opButton(str(option.label) || str(option.name) || option.optionId, 'approval.resolve', () => decide(option.optionId))),
      opButton('Cancel turn', 'approval.cancel', () => mutate('approval.cancel', {id: approval.id}, 'Cancellation requested.'), {class: 'danger'})),
    options.length ? null : caption('The agent did not offer any choices for this request.'),
    can('approval.resolve') ? null : caption(ANSWER_LOCALLY));
}
// A question is known by its id where the agent gives one (Codex), otherwise by its own text (Claude Code).
const qid = question => str(question.id) || str(question.question) || str(question.header);
function inputRequest(v, request) {
  const details = request.details || {}, draft = v.answers[request.id] ||= {}, questions = Array.isArray(details.questions) ? details.questions : null;
  const schema = details.requestedSchema?.type === 'object' ? details.requestedSchema : null, properties = Object.entries(schema?.properties || {});
  const simple = schema && properties.every(([, property]) => ['string', 'number', 'integer', 'boolean'].includes(property.type));
  const respond = async response => {
    await mutate('input.respond', {id: request.id, response, expectedRevision: request.revision}, 'Answer sent.');
    delete v.answers[request.id]; request.status = 'resolved'; renderMain();
  };
  const node = el('div', {class: 'item waiting stack', 'data-key': request.id}, el('div', {class: 'row-head'}, el('h3', {text: requestTitle(request)}), badge(request.status)),
    request.agentId ? caption(agentName(request.agentId)) : null);
  if (questions) {
    for (const question of questions) {
      const options = Array.isArray(question.options) ? question.options : [], title = str(question.question) || str(question.header) || qid(question);
      if (question.multiSelect && options.length) node.append(el('fieldset', {class: 'check-list'}, el('legend', {text: title}),
        options.map(option => el('label', {class: 'check'}, checkbox(draft, qid(question) + ':' + option.label), option.label + (option.description ? ' — ' + option.description : '')))));
      else node.append(label(title, options.length
        ? select(draft, qid(question), options.map(option => ({id: option.label, name: option.label + (option.description ? ' — ' + option.description : '')})), 'Choose an answer')
        : input(draft, qid(question), {type: question.isSecret ? 'password' : 'text'})));
      if (options.length && question.isOther !== false) node.append(label('Or your own answer', input(draft, qid(question) + ':other')));
    }
    node.append(el('div', {class: 'actions'}, opButton('Respond', 'input.respond', () => {
      const answers = {};
      for (const question of questions) {
        const options = Array.isArray(question.options) ? question.options : [], own = str(draft[qid(question) + ':other']).trim();
        const chosen = own ? [own] : question.multiSelect && options.length ? options.filter(option => draft[qid(question) + ':' + option.label]).map(option => option.label) : [str(draft[qid(question)])].filter(Boolean);
        if (!chosen.length) throw new Error('Answer each question before responding.');
        answers[qid(question)] = {answers: chosen};
      }
      return respond({answers});
    }, {class: 'primary'})));
  } else if (simple) {
    for (const [key, property] of properties) {
      const title = property.title || key;
      node.append(property.type === 'boolean' ? el('label', {class: 'check'}, checkbox(draft, key), title)
        : label(title, property.enum ? select(draft, key, property.enum.map(value => ({id: String(value), name: String(value)})), 'Choose')
          : input(draft, key, {type: property.type === 'string' ? 'text' : 'number'}), property.description));
    }
    node.append(el('div', {class: 'actions'}, opButton('Submit', 'input.respond', () => {
      const content = {};
      for (const [key, property] of properties) {
        if (property.type === 'boolean') { content[key] = !!draft[key]; continue; }
        if (!str(draft[key])) { if (schema.required?.includes(key)) throw new Error((property.title || key) + ' is required.'); continue; }
        content[key] = property.type === 'string' ? draft[key] : Number(draft[key]);
        if (property.type === 'integer' && !Number.isInteger(content[key])) throw new Error((property.title || key) + ' must be a whole number.');
      }
      return respond({action: 'accept', content});
    }, {class: 'primary'}), opButton('Decline', 'input.respond', () => respond({action: 'decline'})), opButton('Cancel', 'input.respond', () => respond({action: 'cancel'}))));
  } else {
    node.append(pre(JSON.stringify(details, null, 2), {'aria-label': 'The request'}), label('Your answer as JSON', textarea(draft, 'json', {spellcheck: 'false'}), 'This agent asked in its own format. Answer with JSON in the shape it describes.'),
      el('div', {class: 'actions'}, opButton('Respond', 'input.respond', () => {
        let value;
        try { value = JSON.parse(str(draft.json)); } catch { throw new Error('The answer is not valid JSON.'); }
        return respond(value);
      }, {class: 'primary'})));
  }
  return node;
}

// ---------- agents and delegation ----------
views.Agents = {
  scope: 'workflow',
  create: () => ({draft: {target: '', prompt: '', model: ''}, results: {}, shown: null, agents: paged('agents.list', () => ({...scope(), newestFirst: true}))}),
  // A result that is not final yet is read again with every refresh, so it completes by itself.
  load: v => Promise.all([pull(v.agents), ...Object.keys(v.results).filter(id => !v.results[id].settled).map(id => readResult(v, id))]),
  render: agentsView
};
async function readResult(v, id) {
  const generation = state.generation;
  let result;
  try { result = await call('agents.result', {id}); }
  catch (error) { result = {agentId: id, status: 'unknown', settled: true, output: '', approvals: [], error: {message: error.message}}; }
  if (generation === state.generation) v.results[id] = result;
}
const providerId = provider => typeof provider === 'string' ? provider : provider.id || provider.provider;
const providerReady = provider => provider.available !== false && provider.status !== 'unavailable';
function agentsView(v) {
  const providers = state.snapshot.providers || [], agents = items(v.agents), flow = selectedWorkflow(), writable = projectWritable();
  const targets = [...providers.filter(providerReady).map(provider => ({id: 'new:' + providerId(provider), name: 'A new ' + (name(provider) || providerId(provider)) + ' session'})),
    ...agents.map(agent => ({id: 'agent:' + agent.id, name: 'Continue ' + name(agent) + ' (' + agent.status + ')'}))];
  const delegate = async () => {
    const target = v.draft.target, split = target.indexOf(':'), kind = target.slice(0, split), id = target.slice(split + 1);
    if (!target) throw new Error('Choose who should do the task.');
    const prompt = required(v.draft.prompt, 'what should be done'), model = str(v.draft.model).trim();
    const result = await mutate('agents.delegate', {projectId: state.projectId, prompt, waitMs: 0, ...(kind === 'agent' ? {agentId: id}
      : {provider: id, ...(state.workflowId ? {workflowId: state.workflowId} : {}), ...(model ? {model} : {})})}, 'Task handed over.');
    if (state.views.Agents !== v) return;
    v.results[result.agentId] = result; v.shown = result.agentId;
    // Only what was sent is cleared: something typed while the call was on its way stays.
    if (v.draft.prompt === prompt) v.draft.prompt = '';
    await pull(v.agents); renderMain();
  };
  const shown = v.shown ? v.results[v.shown] : null;
  return [heading('Agents'),
    el('section', {class: 'panel stack'}, el('h3', {text: 'Hand over a task'}),
      el('p', {class: 'muted', text: 'The agent works in this project with its own account and tools. Its result appears here when it is done; if it needs permission it waits under Approvals.'}),
      writable ? null : caption('This project is read only, so agents cannot work in it.'),
      label('Who should do it', select(v.draft, 'target', targets, 'Choose an agent')),
      label('Task', textarea(v.draft, 'prompt', {placeholder: 'Describe what should be done'})),
      label('Model for a new session (optional)', input(v.draft, 'model')),
      el('div', {class: 'actions'}, opButton('Delegate', 'agents.delegate', delegate, {class: 'primary', disabled: !writable}))),
    shown ? resultPanel(v, shown) : null,
    el('div', {class: 'provider-grid'}, providers.map(provider => {
      const id = providerId(provider), ready = providerReady(provider);
      return el('div', {class: 'provider', 'data-key': id}, el('h3', {text: name(provider) || id}), caption(str(provider.status) || (ready ? 'Available' : 'Unavailable')),
        el('p', {text: str(provider.description) || str(provider.reason) || str(provider.error?.message) || 'Official agent session'}),
        opButton('Start session', 'agents.start', () => startAgent(id), {disabled: !ready || !state.workflowId || flow?.status !== 'active' || !writable}));
    })),
    state.workflowId ? null : caption('Choose a workflow to start a session inside it. Handing over a task works without one.'),
    providers.length ? null : caption('No agent programs were found on this computer.'),
    pending(v.agents, 'agents'), agents.map(agent => agentCard(v, agent)),
    v.agents.data && !agents.length ? caption('No agent sessions here yet.') : null, more(v.agents)];
}
function resultPanel(v, result) {
  const waiting = (result.approvals || []).length;
  return el('section', {class: 'panel stack', 'data-key': 'result'}, subheading('Result of ' + agentName(result.agentId), badge(result.status), button('Hide', () => { v.shown = null; renderMain(); })),
    result.settled ? null : caption(waiting ? 'The agent is waiting for your decision.' : 'The agent is working. This updates by itself.'),
    waiting ? el('div', {class: 'actions'}, button('Open approvals', () => changeTab('Approvals'), {class: 'primary'})) : null,
    result.error?.message ? el('p', {class: 'error-text', text: result.error.message}) : null,
    str(result.output) ? pre(result.output, {'aria-label': 'Result'}) : result.settled ? caption('The agent produced no text.') : null,
    result.turn?.outputTruncated ? caption('Only the last part of a very long result is kept.') : null);
}
function agentCard(v, agent) {
  const on = (action, states) => agent.capabilities?.[action] !== false && states.includes(agent.status);
  const say = (action, title, done) => () => {
    const draft = {body: ''};
    dialog(title + ' ' + name(agent), [label('Message', textarea(draft, 'body'))], title, () => mutate('agents.' + action, {id: agent.id, body: required(draft.body, 'a message')}, done));
  };
  return el('div', {class: 'item', 'data-key': agent.id}, el('div', {class: 'row-head'}, el('h3', {text: name(agent)}), badge(agent.status)),
    caption([agent.provider, agent.model, agent.nativeSessionId].filter(Boolean).join(' · ')),
    str(agent.summary) ? el('p', {text: agent.summary}) : null, agent.error?.message ? el('p', {class: 'error-text', text: agent.error.message}) : null,
    el('div', {class: 'actions'},
      opButton('Send', 'agents.send', say('send', 'Send', 'Message queued.'), {disabled: !on('send', ['ready', 'running', 'waiting'])}),
      opButton('Steer', 'agents.steer', say('steer', 'Steer', 'Steering sent.'), {disabled: !on('steer', ['running', 'waiting'])}),
      opButton('Resume', 'agents.resume', () => mutate('agents.resume', {id: agent.id}, 'Resuming.'), {disabled: !on('resume', ['closed', 'disconnected', 'unavailable'])}),
      opButton('Show result', 'agents.result', async () => { await readResult(v, agent.id); v.shown = agent.id; renderMain(); }),
      button('Transcript', () => showTranscript(agent.id)),
      opButton('Cancel turn', 'agents.cancel', () => mutate('agents.cancel', {id: agent.id}, 'Cancellation requested.'), {class: 'danger', disabled: !on('cancel', ['running', 'waiting', 'cancelling'])}),
      opButton('Stop', 'agents.stop', () => mutate('agents.stop', {id: agent.id}, 'Agent stopped.'), {class: 'danger', disabled: !on('stop', ['starting', 'ready', 'running', 'waiting', 'cancelling', 'disconnected', 'unavailable'])})));
}
function startAgent(provider) {
  const draft = {title: '', model: '', sessionId: '', prompt: ''};
  dialog('Start ' + provider, [label('Session label', input(draft, 'title')), label('Model (optional)', input(draft, 'model')),
    label('Existing session to continue (optional)', input(draft, 'sessionId')), label('First instruction (optional)', textarea(draft, 'prompt'))], 'Start session', () =>
    mutate('agents.start', {...scope(), provider, title: draft.title, prompt: draft.prompt, ...(draft.model.trim() ? {model: draft.model.trim()} : {}),
      ...(draft.sessionId.trim() ? {sessionId: draft.sessionId.trim()} : {})}, 'Session starting.'));
}
function showTranscript(agentId) {
  const v = view('Activity');
  v.filter.agent = agentId; v.result.data = null;
  return changeTab('Activity');
}

// ---------- activity ----------
views.Activity = {
  scope: 'workflow',
  create: () => {
    const v = {filter: {agent: ''}, open: null, events: [], start: null, eventError: null, reading: false};
    v.jobs = paged('job.list', () => ({...scope(), newestFirst: true}), 20);
    v.job = source(() => call('job.read', {id: v.open}));
    v.result = source(() => call('agents.result', {id: v.filter.agent}));
    v.agents = source(() => everything('agents.list', scope()));
    return v;
  },
  load: v => Promise.all([pull(v.jobs), pull(v.agents), v.open ? pull(v.job) : null, v.filter.agent ? pull(v.result) : null, loadEvents(v)]),
  render: activityView
};
async function readEvents(after, before = Infinity) {
  const found = [];
  let cursor = after;
  for (let page = 0; page < 5; page++) {
    const result = await call('event.list', {...scope(), cursor, limit: 100}), list = result.items || [], wanted = list.filter(event => event.sequence < before);
    found.push(...wanted);
    if (!result.nextCursor || wanted.length < list.length) break;
    cursor = result.nextCursor;
  }
  return found;
}
// The journal is read forward by sequence: first the newest stretch, then whatever was added since, or an earlier stretch on request.
async function loadEvents(v, earlier = false) {
  if (v.reading) return;
  v.reading = true;
  const generation = state.generation, current = () => generation === state.generation;
  try {
    if (v.start === null) {
      // The newest events of this scope, not the newest stretch of the whole journal: a project that was quiet
      // while another was busy would otherwise show nothing.
      const found = (await call('event.list', {...scope(), latest: true, limit: 100})).items || [];
      if (current()) { v.start = Math.max(0, (found[0]?.sequence ?? state.snapshot.revision ?? 1) - 1); v.events = found; }
    } else if (earlier) {
      const start = Math.max(0, v.start - 300), found = await readEvents(start, v.events[0]?.sequence ?? v.start + 1);
      if (current()) { v.start = start; v.events = [...found, ...v.events]; }
    } else {
      const found = await readEvents(v.events.at(-1)?.sequence ?? v.start);
      if (current()) v.events = [...v.events, ...found].slice(-1000);
    }
    if (current()) v.eventError = null;
  } catch (error) { if (current()) v.eventError = error; }
  finally { v.reading = false; }
}
const spoken = event => event.type === 'agent.native' && event.nativeEvent?.type === 'message' && typeof event.nativeEvent.text === 'string' ? event.nativeEvent.text : null;
// Consecutive pieces of one agent's streamed answer read as one entry.
function transcript(events, agentId) {
  const entries = [];
  for (const event of events) {
    if (agentId && event.agentId !== agentId && event.entityId !== agentId && event.entity?.agentId !== agentId) continue;
    const text = spoken(event), last = entries.at(-1);
    if (text !== null && event.nativeEvent.delta && last?.said && last.agentId === event.agentId && last.jobId === event.jobId) last.text += text;
    else entries.push(text !== null ? {key: event.sequence, said: true, agentId: event.agentId, jobId: event.jobId, text, at: event.createdAt}
      : {key: event.sequence, text: describe(event), at: event.createdAt});
  }
  return entries;
}
function activityView(v) {
  const agentId = v.filter.agent, entries = transcript(v.events, agentId), result = v.result.data;
  const jobs = items(v.jobs).filter(job => !agentId || job.agentId === agentId);
  const pick = () => { v.result.data = null; v.result.error = null; renderMain(); if (v.filter.agent) void pull(v.result).then(repaint); };
  return [heading('Activity', label('Agent', select(v.filter, 'agent', v.agents.data ? items(v.agents) : state.snapshot.agents || [], 'All agents', {}, {changed: pick}))),
    agentId ? el('section', {class: 'panel stack', 'data-key': 'latest'}, subheading('Latest result of ' + agentName(agentId), result ? badge(result.status) : null),
      pending(v.result, 'the latest result'),
      result ? (str(result.output) ? pre(result.output, {'aria-label': 'Latest result'}) : caption(result.settled ? 'The agent has not produced a result.' : 'The agent is still working.')) : null) : null,
    el('section', {class: 'panel'}, el('h3', {text: 'Turns and jobs'}), pending(v.jobs, 'turns and jobs'), jobs.map(job => jobRow(v, job)),
      v.jobs.data && !jobs.length ? caption('No agent turns or jobs here yet.') : null, more(v.jobs)),
    el('section', {class: 'panel'}, subheading('What happened', v.start ? button('Load earlier', () => loadEvents(v, true).then(repaint)) : null),
      v.eventError ? el('p', {class: 'error-text', role: 'alert', text: 'Could not load events: ' + v.eventError.message}) : null,
      entries.length ? el('div', {class: 'log', tabindex: '0', role: 'region', 'aria-label': 'Events, oldest first'}, entries.map(entry =>
        el('div', {class: entry.said ? 'entry said' : 'entry', 'data-key': String(entry.key)}, el('span', {class: 'caption', text: time(entry.at) + (entry.said ? ' · ' + agentName(entry.agentId) : '')}), el('p', {text: entry.text}))))
        : caption(v.start === null && !v.eventError ? 'Loading events…' : 'Nothing has happened here recently.'))];
}
function jobRow(v, job) {
  const open = v.open === job.id, command = str(job.input?.args?.command) || str(job.input?.args?.file) || str(job.input?.args?.capability);
  const title = job.kind === 'agent-turn' ? 'Turn of ' + agentName(job.agentId) : (job.kind === 'command' ? 'Command' : 'Capability') + (command ? ': ' + command.slice(0, 120) : '');
  const toggle = async () => {
    v.open = open ? null : job.id; v.job.data = null; v.job.error = null; renderMain();
    if (v.open) { await pull(v.job); renderMain(); }
  };
  return el('div', {class: 'item', 'data-key': job.id}, el('div', {class: 'row-head'}, el('h3', {text: title}), badge(job.status)),
    caption(['Started ' + date(job.createdAt), job.finishedAt ? 'finished ' + time(job.finishedAt) : ''].filter(Boolean).join(' · ')),
    el('div', {class: 'actions'}, button(open ? 'Hide output' : 'Show output', toggle, {'aria-expanded': String(open)})), open ? jobDetail(v) : null);
}
function jobDetail(v) {
  const job = v.job.data;
  if (!job) return pending(v.job, 'this output');
  // A turn that is still running has no stored output yet; its streamed pieces are in the journal.
  const text = str(job.output) || (job.status === 'running' ? v.events.filter(event => event.jobId === job.id).map(spoken).filter(piece => piece !== null).join('') : '');
  return el('div', {class: 'stack'}, job.error?.message ? el('p', {class: 'error-text', text: job.error.message}) : null,
    text ? pre(text, {'aria-label': 'Output'}) : caption(job.status === 'running' ? 'No output yet. This updates while it runs.' : 'This produced no output.'),
    job.outputTruncated ? caption('Only the last part of a very long output is kept.') : null);
}

// ---------- messages ----------
views.Messages = {
  scope: 'workflow',
  create: () => ({draft: {body: ''}, to: {}, messages: paged('message.list', () => ({...scope(), newestFirst: true})), agents: source(() => everything('agents.list', scope()))}),
  load: v => Promise.all([pull(v.messages), pull(v.agents)]),
  render: messagesView
};
function messagesView(v) {
  const agents = items(v.agents), messages = items(v.messages);
  const send = async () => {
    const recipientIds = agents.filter(agent => v.to[agent.id]).map(agent => agent.id);
    if (!recipientIds.length) throw new Error('Choose at least one agent to send the message to.');
    await mutate('message.send', {...scope(), recipientIds, body: required(v.draft.body, 'a message')}, 'Message sent.');
    v.draft.body = ''; await pull(v.messages); renderMain();
  };
  return [heading('Messages'),
    el('section', {class: 'panel stack'}, el('p', {class: 'muted', text: 'A message is delivered to each chosen agent as its next turn. Answers appear below, newest first.'}),
      state.workflowId ? null : caption('Choose a workflow to send messages.'),
      el('fieldset', {class: 'check-list'}, el('legend', {text: 'Send to'}), agents.map(agent => el('label', {class: 'check', 'data-key': agent.id}, checkbox(v.to, agent.id), name(agent))),
        agents.length ? null : caption(v.agents.data ? 'There are no agents here yet.' : v.agents.error ? 'Could not load agents: ' + v.agents.error.message : 'Loading agents…')),
      label('Message', textarea(v.draft, 'body', {placeholder: 'Write to the selected agents'})),
      el('div', {class: 'actions'}, opButton('Send message', 'message.send', send, {class: 'primary', disabled: !state.workflowId}))),
    pending(v.messages, 'messages'),
    messages.map(message => el('div', {class: 'item message', 'data-key': message.id},
      el('div', {class: 'row-head'}, el('h3', {text: str(message.sender?.label) || str(message.sender?.id) || 'Message'}), badge(message.status)),
      el('p', {text: str(message.body)}),
      caption([date(message.createdAt), (message.recipientIds || []).length ? 'to ' + message.recipientIds.map(agentName).join(', ') : ''].filter(Boolean).join(' · ')))),
    v.messages.data && !messages.length ? caption('No messages yet.') : null, more(v.messages)];
}

// ---------- tasks ----------
views.Tasks = {
  scope: 'workflow',
  create: () => ({tasks: paged('task.list', () => ({...scope(), newestFirst: true})), agents: source(() => everything('agents.list', scope()))}),
  load: v => Promise.all([pull(v.tasks), pull(v.agents)]),
  render: tasksView
};
function tasksView(v) {
  const tasks = items(v.tasks);
  const create = () => {
    const draft = {title: '', instruction: '', assignee: ''};
    dialog('Create task', [label('Title', input(draft, 'title')), label('Instruction', textarea(draft, 'instruction')), label('Assigned agent', select(draft, 'assignee', items(v.agents), 'Unassigned'))], 'Create', () =>
      mutate('task.create', {...scope(), title: required(draft.title, 'a title'), instruction: required(draft.instruction, 'an instruction'), ...(draft.assignee ? {assigneeId: draft.assignee} : {})}, 'Task created.'));
  };
  const edit = task => {
    const draft = {title: task.title, instruction: str(task.instruction), assignee: task.assigneeId || ''}, unassigned = task.status === 'pending';
    dialog('Edit task', [label('Title', input(draft, 'title')), label('Instruction', textarea(draft, 'instruction')),
      unassigned ? label('Assigned agent', select(draft, 'assignee', items(v.agents), 'Unassigned')) : null], 'Save', () =>
      mutate('task.update', {id: task.id, title: required(draft.title, 'a title'), instruction: required(draft.instruction, 'an instruction'), expectedRevision: task.revision,
        ...(unassigned && draft.assignee && draft.assignee !== task.assigneeId ? {assigneeId: draft.assignee} : {})}, 'Task saved.'));
  };
  return [heading('Tasks', opButton('Create task', 'task.create', create, {class: 'primary', disabled: !state.workflowId})),
    state.workflowId ? null : caption('Choose a workflow to create tasks.'), pending(v.tasks, 'tasks'),
    tasks.map(task => el('div', {class: 'item', 'data-key': task.id}, el('div', {class: 'row-head'}, el('h3', {text: task.title}), badge(task.status)),
      el('p', {text: str(task.instruction) || str(task.description)}), caption(task.assigneeId ? 'Assigned to ' + agentName(task.assigneeId) : 'Unassigned'),
      str(task.result) ? pre(task.result, {'aria-label': 'Result'}) : null,
      el('div', {class: 'actions'}, referenceButton(task, 'task'), opButton('Edit', 'task.update', () => edit(task), {disabled: ['running', 'queued'].includes(task.status)}),
        ['pending', 'queued', 'running', 'blocked'].includes(task.status) ? opButton('Cancel task', 'task.update',
          () => mutate('task.update', {id: task.id, status: 'cancelled', expectedRevision: task.revision}, 'Task cancelled.'), {class: 'danger'}) : null))),
    v.tasks.data && !tasks.length ? caption('No tasks yet.') : null, more(v.tasks)];
}

// ---------- files ----------
views.Files = {
  scope: 'project',
  create: () => {
    const v = {path: '', draft: {path: '', query: ''}, file: null, lookup: null, showHistory: false, reading: null};
    v.entries = paged('workspace.files', () => ({projectId: state.projectId, path: v.path}), 200);
    v.results = source(() => v.lookup.kind === 'find' ? call('workspace.find', {projectId: state.projectId, pattern: v.lookup.text})
      : call('workspace.search', {projectId: state.projectId, query: v.lookup.text}));
    v.history = source(() => call('workspace.history', {projectId: state.projectId, path: v.file.path, limit: 50}));
    return v;
  },
  load: v => Promise.all([pull(v.entries), followFile(v), v.showHistory && v.file ? pull(v.history) : null]),
  render: filesView
};
const dirty = file => !!file && !file.truncated && file.text !== file.savedText;
const fileStatus = file => file.truncated ? 'Showing lines ' + file.startLine + '–' + file.endLine + ' of ' + file.totalLines + '. This file is too large to edit here, so it is shown read only.'
  : dirty(file) ? 'Unsaved changes' : file.isNew ? 'New file, not saved yet' : 'Saved';
const leaveFile = v => !dirty(v.file) || confirmAction('Discard unsaved changes?', 'Your edits to ' + v.file.path + ' have not been saved.', 'Discard changes');
async function readFile(v, path, startLine, starts = []) {
  const ticket = v.reading = {};
  const result = await call('workspace.read', {projectId: state.projectId, path, ...(startLine ? {startLine} : {})});
  if (v.reading !== ticket || state.views.Files !== v) return; // a newer choice, or another project, took over
  // Any page that is not the whole file, including the last one, is partial and therefore read only.
  v.file = {...result, path: str(result.path) || path, text: str(result.text), savedText: str(result.text), isNew: false, starts,
    truncated: !!result.truncated || result.startLine > 1};
  if (v.showHistory) void pull(v.history).then(repaint);
  renderMain();
}
async function openFile(v, path) { if (await leaveFile(v)) { v.showHistory = false; await readFile(v, path); } }
// A file that is open without unsaved edits follows what is on disk, for example while an agent changes it.
async function followFile(v) {
  const file = v.file;
  if (!file || file.isNew || file.truncated || dirty(file)) return;
  let latest;
  try { latest = await call('workspace.read', {projectId: state.projectId, path: file.path}); } catch { return; }
  if (v.file !== file || dirty(file) || latest.sha256 === file.sha256) return;
  Object.assign(file, latest, {path: file.path, text: str(latest.text), savedText: str(latest.text)});
}
async function browse(v, path) {
  v.path = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); v.draft.path = v.path; v.entries.data = null; v.entries.error = null;
  renderMain(); await pull(v.entries); renderMain();
}
async function saveFile(v) {
  const file = v.file, text = file.text;
  const result = await mutate('workspace.write', {projectId: state.projectId, path: file.path, text, expectedSha256: file.isNew ? null : file.sha256}, 'Saved.');
  file.sha256 = result.sha256; file.savedText = text; file.isNew = false; file.path = str(result.path) || file.path;
  await pull(v.entries); renderMain();
}
async function lookup(v, kind) {
  v.lookup = {kind, text: required(v.draft.query, kind === 'find' ? 'a file pattern, for example *.json' : 'the text to search for')};
  v.results.data = null; v.results.error = null; renderMain(); await pull(v.results); renderMain();
}
function newFile(v) {
  const draft = {path: v.path ? v.path + '/' : ''};
  dialog('New file', [label('File path in the project', input(draft, 'path'), 'Folders that do not exist yet are created when you save.')], 'Create draft', async () => {
    const path = required(draft.path, 'a file path');
    if (!await leaveFile(v)) return false;
    v.file = {path, text: '', savedText: '', isNew: true, sha256: null}; v.showHistory = false; renderMain();
  });
}
function newFolder(v) {
  const draft = {path: v.path ? v.path + '/' : ''};
  dialog('New folder', [label('Folder path in the project', input(draft, 'path'))], 'Create folder', async () => {
    await mutate('workspace.mkdir', {projectId: state.projectId, path: required(draft.path, 'a folder path')}, 'Folder created.');
    await pull(v.entries); renderMain();
  });
}
function moveEntry(v, from) {
  const draft = {to: from};
  dialog('Rename or move', [caption('From ' + from), label('New path in the project', input(draft, 'to'))], 'Move', async () => {
    const moved = await mutate('workspace.move', {projectId: state.projectId, from, to: required(draft.to, 'the new path')}, 'Moved.');
    const to = str(moved?.to) || draft.to.trim().replace(/\\/g, '/');
    if (v.file?.path === from) v.file.path = to;
    if (v.path === from || v.path.startsWith(from + '/')) { v.path = to + v.path.slice(from.length); v.draft.path = v.path; }
    await pull(v.entries); renderMain();
  });
}
async function deleteEntry(v, path, folder) {
  if (!await confirmAction('Delete ' + path + '?', folder ? 'The folder and everything in it is deleted. Its files can be restored one by one under Changes.'
    : 'The file is deleted. It can be restored under Changes.', 'Delete')) return;
  const remove = force => mutate('workspace.delete', {projectId: state.projectId, path, ...(folder ? {recursive: true} : {}), ...(force ? {force: true} : {})}, 'Deleted ' + path + '.');
  try { await remove(false); }
  catch (error) {
    // More than DevMate keeps for undo: deleting it for good is a second, explicit decision.
    if (error.code !== 'too_large_to_keep' || !await confirmAction('Delete without a way back?', 'This folder is too large for DevMate to keep restorable copies of its files. Deleting it cannot be undone.', 'Delete for good')) throw error;
    await remove(true);
  }
  if (v.file && (v.file.path === path || v.file.path.startsWith(path + '/'))) v.file = null;
  if (v.path === path || v.path.startsWith(path + '/')) { v.path = path.split('/').slice(0, -1).join('/'); v.draft.path = v.path; }
  await pull(v.entries); renderMain();
}
async function restoreVersion(path, sha256) {
  await mutate('workspace.restore', {projectId: state.projectId, path, sha256}, 'Restored ' + path + '.');
  const files = state.views.Files;
  if (files?.file?.path === path) await readFile(files, path);
}
const historyRow = (entry, withPath) => el('div', {class: 'entry', 'data-key': String(entry.sequence)},
  el('div', {class: 'row-head'}, el('strong', {text: (withPath ? entry.path + ' · ' : '') + entry.action + (entry.from ? ' from ' + entry.from : '')}), el('span', {class: 'caption', text: date(entry.at)})),
  entry.previousRestorable ? el('div', {class: 'actions'}, opButton('Restore previous version', 'workspace.restore', async () => {
    const files = state.views.Files;
    if (files?.file?.path === entry.path && !await leaveFile(files)) return;
    await restoreVersion(entry.path, entry.previousSha256);
  }, {disabled: !projectWritable(), 'aria-label': 'Restore previous version of ' + entry.path})) : null);
function filesView(v) {
  const entries = items(v.entries), writable = projectWritable(), parent = v.path.split('/').slice(0, -1).join('/');
  return [heading('Files', opButton('New file', 'workspace.write', () => newFile(v), {disabled: !writable}), opButton('New folder', 'workspace.mkdir', () => newFolder(v), {disabled: !writable})),
    form({class: 'toolbar'}, input(v.draft, 'path', {placeholder: 'Folder path', 'aria-label': 'Folder path'}), submitButton('Browse', () => browse(v, v.draft.path))),
    form({class: 'toolbar', role: 'search'}, input(v.draft, 'query', {placeholder: 'Text to search for, or a file pattern such as *.json', 'aria-label': 'Search text or file pattern'}),
      submitButton('Search text', () => lookup(v, 'search')), opButton('Find files', 'workspace.find', () => lookup(v, 'find'))),
    v.lookup ? el('section', {class: 'panel', 'data-key': 'lookup'}, subheading((v.lookup.kind === 'find' ? 'Files matching ' : 'Text matches for ') + v.lookup.text, button('Clear results', () => { v.lookup = null; renderMain(); })),
      pending(v.results, 'the results'),
      items(v.results).map(hit => el('div', {class: 'hit'}, button(hit.path + (hit.line ? ':' + hit.line : ''), () => openFile(v, hit.path)), hit.text ? el('code', {text: hit.text.trim().slice(0, 300)}) : null)),
      v.results.data && !items(v.results).length ? caption('Nothing matches.') : null,
      v.results.data?.truncated ? caption('There are more matches. Narrow the search to see them.') : null) : null,
    el('div', {class: 'split'},
      el('section', {class: 'panel files', 'aria-label': 'Folder contents'}, caption(v.path ? 'In ' + v.path : 'Project folder'),
        v.path ? el('div', {class: 'actions'}, button('Up', () => browse(v, parent)), opButton('Rename', 'workspace.move', () => moveEntry(v, v.path), {disabled: !writable, 'aria-label': 'Rename or move this folder'}),
          opButton('Delete', 'workspace.delete', () => deleteEntry(v, v.path, true), {class: 'danger', disabled: !writable, 'aria-label': 'Delete this folder'})) : null,
        pending(v.entries, 'this folder'),
        entries.map(entry => el('button', {type: 'button', 'data-key': entry.path, class: v.file?.path === entry.path ? 'selected' : '', text: (entry.type === 'directory' ? '▸ ' : '') + entry.name,
          onclick: event => act(event.currentTarget, () => entry.type === 'directory' ? browse(v, entry.path) : openFile(v, entry.path))})),
        v.entries.data && !entries.length ? caption('This folder is empty.') : null, more(v.entries)),
      filePanel(v, writable))];
}
function filePanel(v, writable) {
  const file = v.file;
  if (!file) return el('section', {class: 'panel'}, empty('Browse project files', 'Select a file to read or edit it. Saving checks that the file has not changed since you opened it.'));
  const page = startLine => readFile(v, file.path, startLine, startLine > file.startLine ? [...file.starts, file.startLine] : file.starts.slice(0, -1));
  const history = async () => { v.showHistory = !v.showHistory; v.history.data = null; v.history.error = null; renderMain(); if (v.showHistory) { await pull(v.history); renderMain(); } };
  const uri = 'devmate://project/' + encodeURIComponent(state.projectId) + '/file/' + file.path.split('/').map(encodeURIComponent).join('/');
  return el('section', {class: 'panel', 'data-key': 'file'},
    heading(file.path,
      file.truncated ? null : opButton('Save', 'workspace.write', () => saveFile(v), {class: 'primary', disabled: !writable}),
      file.isNew ? null : [opButton('Rename or move', 'workspace.move', () => moveEntry(v, file.path), {disabled: !writable}),
        opButton('Delete', 'workspace.delete', () => deleteEntry(v, file.path, false), {class: 'danger', disabled: !writable}),
        opButton(v.showHistory ? 'Hide history' : 'History', 'workspace.history', history, {'aria-expanded': String(v.showHistory)}),
        opButton('Reference', 'reference.add', () => addReference({uri, name: file.path, mimeType: 'text/plain'}), {disabled: !state.workflowId})]),
    file.truncated ? pre(file.text, {class: 'preview file-view', 'aria-label': 'File contents'})
      : textarea(file, 'text', {class: 'file-editor', 'aria-label': 'File contents', spellcheck: 'false', readOnly: !writable},
        {changed: () => { const node = $('file-status'); if (node) node.textContent = fileStatus(file); }}),
    el('p', {id: 'file-status', class: 'caption', text: fileStatus(file)}),
    str(file.note) ? caption(file.note) : null,
    file.truncated ? el('div', {class: 'actions'}, button('Previous lines', () => page(file.starts.at(-1)), {disabled: !file.starts.length}),
      button('Next lines', () => page(file.nextStartLine), {disabled: !file.nextStartLine})) : null,
    v.showHistory ? el('div', {class: 'stack'}, el('h3', {text: 'Changes DevMate made to this file'}), pending(v.history, 'the history'),
      items(v.history).map(entry => historyRow(entry, false)), v.history.data && !items(v.history).length ? caption('DevMate has not changed this file.') : null) : null);
}
async function showFile(path) {
  await changeTab('Files');
  await openFile(view('Files'), path);
}

// ---------- changes ----------
views.Changes = {
  scope: 'project',
  create: () => {
    const v = {options: {staged: false}, shown: null};
    v.status = source(() => call('git.status', {projectId: state.projectId}));
    v.diff = source(() => call('git.diff', {projectId: state.projectId, ...(v.shown.path ? {paths: [v.shown.path]} : {}), ...(v.options.staged ? {staged: true} : {})}));
    v.history = source(() => call('workspace.history', {projectId: state.projectId, limit: 50}));
    return v;
  },
  load: v => Promise.all([pull(v.status), pull(v.history), v.shown ? pull(v.diff) : null]),
  render: changesView
};
const GIT_WORDS = {'?': 'new, not tracked', M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', U: 'conflict', T: 'type changed'};
const gitWord = status => [...new Set([...String(status)].map(letter => GIT_WORDS[letter]).filter(Boolean))].join(', ') || String(status).trim();
function changesView(v) {
  const changed = items(v.status), recent = items(v.history), diff = v.diff.data;
  const show = async path => { v.shown = {path}; v.diff.data = null; v.diff.error = null; renderMain(); await pull(v.diff); renderMain(); };
  return [heading('Changes'),
    el('section', {class: 'panel'}, subheading('Git: files that differ from the last commit', button('Show whole diff', () => show(null)),
      el('label', {class: 'check'}, checkbox(v.options, 'staged', {}, {changed: () => { if (v.shown) void pull(v.diff).then(repaint); }}), 'Staged changes only')),
      v.status.error ? el('div', {class: 'problem'}, el('p', {class: 'error-text', role: 'alert', text: 'Git status is not available for this project (it may not be a Git repository): ' + v.status.error.message}),
        button('Try again', () => pull(v.status).then(repaint))) : pending(v.status, 'the Git status'),
      changed.map(item => el('div', {class: 'hit', 'data-key': item.path}, button(item.path, () => show(item.path), {disabled: !!item.protected, 'aria-label': 'Show diff of ' + item.path}),
        el('span', {class: 'caption', text: gitWord(item.status) + (item.originalPath ? ' from ' + item.originalPath : '') + (item.protected ? ' · protected, content not shown' : '')}))),
      v.status.data && !changed.length ? caption('The working tree is clean.') : null),
    v.shown ? el('section', {class: 'panel', 'data-key': 'diff'}, subheading('Diff of ' + (v.shown.path || 'all changed files'), button('Hide', () => { v.shown = null; renderMain(); })),
      pending(v.diff, 'the diff'),
      diff ? (str(diff.stdout).trim() ? pre(diff.stdout, {class: 'preview diff', 'aria-label': 'Diff'}) : caption('Nothing to show. A new file that Git does not track yet has no diff.')) : null,
      diff?.truncated ? caption('The diff is long and was cut. Open a single file to see all of it.') : null) : null,
    el('section', {class: 'panel'}, el('h3', {text: 'Changed through DevMate'}),
      el('p', {class: 'muted', text: 'Every file that an assistant, an agent tool or this workbench wrote, moved or deleted through DevMate, newest first. The version from before each change can be put back.'}),
      pending(v.history, 'the change history'), recent.map(entry => historyRow(entry, true)),
      v.history.data && !recent.length ? caption('DevMate has not changed anything in this project.') : null)];
}

// ---------- commands ----------
views.Commands = {
  scope: 'project',
  create: () => {
    const v = {draft: {command: '', cwd: ''}, selected: null, page: null, tail: true, reading: null, readAt: 0};
    v.processes = source(() => call('process.list', {projectId: state.projectId}));
    return v;
  },
  load: v => Promise.all([pull(v.processes), v.selected && v.tail ? readOutput(v) : null]),
  render: commandsView,
  // While the newest output is shown, keep its end in view.
  after: v => { const node = $('command-output'); if (node && v.tail) node.scrollTop = node.scrollHeight; }
};
const OUTPUT_PAGE = 65536;
// One page of output at a time: the newest (no cursor), or the page that starts at a byte offset.
function outputPage(result, cursor) {
  const start = result.outputStartsAt || 0;
  return {id: result.id, text: str(result.output), from: cursor === undefined ? result.skippedBytes || 0 : Math.max(cursor, start), next: result.cursor ?? 0, hasMore: !!result.hasMore,
    total: result.outputBytes ?? 0, start, status: result.status, note: str(result.note), error: null};
}
async function readOutput(v, cursor, maxBytes = OUTPUT_PAGE) {
  const id = v.selected, ticket = v.reading = {};
  v.readAt = Date.now();
  let page;
  try { page = outputPage(await call('process.read', {id, maxBytes, ...(cursor === undefined ? {} : {cursor})}), cursor); }
  catch (error) { page = {id, text: '', error}; }
  if (v.reading !== ticket || v.selected !== id) return;
  v.page = page; v.tail = cursor === undefined;
}
function commandsView(v) {
  const processes = [...items(v.processes)].reverse(), writable = projectWritable(), page = v.page?.id === v.selected ? v.page : null;
  const selected = processes.find(item => item.id === v.selected);
  const open = async id => { v.selected = id; v.page = null; v.tail = true; renderMain(); await readOutput(v); renderMain(); };
  const turn = (cursor, maxBytes) => readOutput(v, cursor, maxBytes).then(repaint);
  const run = async () => {
    const command = required(v.draft.command, 'a command'), cwd = str(v.draft.cwd).trim();
    const result = await mutate('shell.run', {projectId: state.projectId, command, ...(cwd ? {cwd} : {}), waitMs: 1000}, 'Command started.');
    if (state.views.Commands !== v) return;
    if (v.draft.command === command) v.draft.command = '';
    v.selected = result.id; v.page = outputPage(result); v.tail = true;
    await pull(v.processes); renderMain();
  };
  return [heading('Commands'),
    el('section', {class: 'panel stack'}, el('h3', {text: 'Run a command'}),
      el('p', {class: 'muted', text: 'The command runs on this DevMate computer in the project folder, with your own account and environment. A command that keeps running, such as a development server, stays listed below until you stop it.'}),
      writable ? null : caption('This project is read only, so commands cannot be run in it.'),
      form({class: 'stack'}, label('Command', input(v.draft, 'command', {spellcheck: 'false', autocomplete: 'off', placeholder: 'For example: npm test'})),
        label('Folder inside the project (optional)', input(v.draft, 'cwd', {spellcheck: 'false', autocomplete: 'off'})),
        el('div', {class: 'actions'}, submitButton('Run', run, {class: 'primary', disabled: !writable || !can('shell.run')})))),
    el('section', {class: 'panel'}, el('h3', {text: 'Commands of this session'}), pending(v.processes, 'commands'),
      processes.map(item => el('div', {class: 'item', 'data-key': item.id}, el('div', {class: 'row-head'}, el('code', {text: str(item.label) || item.command}),
        badge(item.status === 'exited' ? 'exited ' + (item.exitCode ?? '') : item.status, item.status === 'exited' && item.exitCode ? 'error' : tone(item.status))),
        caption(['Started ' + time(item.startedAt), item.finishedAt ? 'ended ' + time(item.finishedAt) : '', item.cwd && item.cwd !== '.' ? 'in ' + item.cwd : '', item.shell,
          item.backgroundOutput ? 'something it started is still running' : ''].filter(Boolean).join(' · ')),
        el('div', {class: 'actions'}, button(v.selected === item.id ? 'Showing output' : 'Show output', () => open(item.id), {'aria-pressed': String(v.selected === item.id)}),
          opButton('Stop', 'process.stop', () => mutate('process.stop', {id: item.id}, 'Command stopped.'), {class: 'danger', disabled: item.status !== 'running' && !item.backgroundOutput})))),
      v.processes.data && !processes.length ? caption('No commands have been run in this project since DevMate started.') : null),
    v.selected ? el('section', {class: 'panel', 'data-key': 'output'}, subheading('Output' + (selected ? ' of ' + (str(selected.label) || selected.command).slice(0, 80) : ''), button('Hide', () => { v.selected = null; v.page = null; renderMain(); })),
      !page ? caption('Loading output…') : page.error ? el('p', {class: 'error-text', role: 'alert', text: 'Could not read the output: ' + page.error.message}) : [
        pre(page.text || '(no output in this part)', {id: 'command-output', 'aria-label': 'Command output'}),
        caption('Showing ' + page.from + ' to ' + page.next + ' of ' + page.total + ' bytes' + (page.start ? '; the first ' + page.start + ' bytes are no longer kept' : '') + (v.tail ? ' · following the newest output' : '')),
        page.note ? caption(page.note) : null,
        el('div', {class: 'actions'},
          button('Earlier', () => { const from = Math.max(page.start, page.from - OUTPUT_PAGE); return turn(from, Math.max(16, page.from - from)); }, {disabled: page.from <= page.start}),
          button('Later', () => turn(page.next), {disabled: !page.hasMore}), button('Newest', () => turn(), {disabled: v.tail && !page.hasMore}))]) : null];
}

// ---------- problems ----------
views.Problems = {
  scope: 'project',
  create: () => {
    const v = {filter: {severity: 'warning'}};
    v.problems = source(() => call('editor.diagnostics', {projectId: state.projectId, severity: v.filter.severity, limit: 500}));
    return v;
  },
  load: v => pull(v.problems),
  render: v => {
    const data = v.problems.data, list = items(v.problems), counts = data?.counts || {};
    const levels = [{id: 'error', name: 'Errors only'}, {id: 'warning', name: 'Errors and warnings'}, {id: 'info', name: 'Also information'}, {id: 'hint', name: 'Everything, with hints'}];
    return [heading('Problems', label('Show', select(v.filter, 'severity', levels, null, {}, {changed: () => pull(v.problems).then(repaint)}))),
      el('p', {class: 'muted', text: 'What the editor currently reports for this project: compiler, type checker and linter findings. Nothing is built or run to produce this list.'}),
      pending(v.problems, 'problems'),
      data && !data.attachedWindows ? empty('No editor is attached', 'Problems come from a VS Code window that has this project open with the DevMate extension running. Open the project there to see them here.') : null,
      data?.attachedWindows ? el('div', {class: 'actions'}, ['error', 'warning', 'info', 'hint'].filter(level => counts[level] !== undefined).map(level => badge(counts[level] + ' ' + level + (counts[level] === 1 || level === 'info' ? '' : 's'), counts[level] ? tone(level) : ''))) : null,
      list.map((item, index) => el('div', {class: 'item', 'data-key': [item.path, item.line, item.character, index].join(':')},
        el('div', {class: 'row-head'}, button(item.path + ':' + item.line + ':' + item.character, () => showFile(item.path), {'aria-label': 'Open ' + item.path}), badge(item.severity)),
        el('p', {text: item.message}), item.source ? caption(item.source + (item.code ? ' ' + item.code : '')) : null)),
      data?.attachedWindows && !list.length ? caption('The editor reports nothing at this level.') : null,
      data?.truncated ? caption('There are more than are shown here. Narrow the level to see the most important ones.') : null];
  }
};

// ---------- artifacts ----------
views.Artifacts = {
  scope: 'workflow',
  create: () => ({artifacts: paged('artifact.list', () => ({...scope(), newestFirst: true}))}),
  load: v => pull(v.artifacts),
  render: v => {
    const create = () => {
      const draft = {name: '', mime: 'text/plain', path: ''};
      dialog('Register artifact', [label('Name', input(draft, 'name')), label('MIME type', input(draft, 'mime')), label('Existing project file path', input(draft, 'path'))], 'Register', () =>
        mutate('artifact.create', {...scope(), ...(draft.name.trim() ? {name: draft.name.trim()} : {}), mimeType: draft.mime, path: required(draft.path, 'the path of a project file')}, 'Artifact registered.'));
    };
    const read = async artifact => {
      const result = await call('artifact.read', {id: artifact.id});
      dialog(name(artifact), [pre(typeof result.text === 'string' ? result.text : 'This artifact is not text (' + (result.mimeType || 'unknown type') + ', ' + (result.bytes ?? '?') + ' bytes).', {'aria-label': 'Artifact contents'})]);
    };
    return [heading('Artifacts', opButton('Create artifact', 'artifact.create', create, {disabled: !state.workflowId})),
      state.workflowId ? null : caption('Choose a workflow to register artifacts.'), pending(v.artifacts, 'artifacts'),
      items(v.artifacts).map(artifact => el('div', {class: 'item', 'data-key': artifact.id}, el('div', {class: 'row-head'}, el('h3', {text: name(artifact)}), badge(artifact.mimeType || 'artifact', '')),
        caption([artifact.path, artifact.bytes === undefined ? '' : artifact.bytes + ' bytes'].filter(Boolean).join(' · ')),
        el('div', {class: 'actions'}, opButton('Read', 'artifact.read', () => read(artifact)), referenceButton(artifact, 'artifact')))),
      v.artifacts.data && !items(v.artifacts).length ? caption('No artifacts yet.') : null, more(v.artifacts)];
  }
};

// ---------- references ----------
async function loadReferences() {
  const generation = state.generation;
  if (!state.projectId) { state.references = []; return; }
  try { const result = await everything('reference.list', scope()); if (generation === state.generation) state.references = result.items; }
  catch (error) { if (generation === state.generation) fail(error); }
}
async function addReference(reference) {
  await mutate('reference.add', {...scope(), ...reference}, 'Reference added.');
}
function referenceButton(record, kind) {
  const uri = record.uri || 'devmate://' + kind + '/' + encodeURIComponent(record.id);
  return opButton('Reference', 'reference.add', () => addReference({uri, name: name(record), ...(record.mimeType ? {mimeType: record.mimeType} : {})}), {disabled: !state.workflowId});
}
const contextText = list => list.map(reference => name(reference) + '\n' + reference.uri + (reference.description ? '\n' + reference.description : '')).join('\n\n');
function renderReferences() {
  const list = state.references;
  $('reference-count').textContent = String(list.length);
  morphChildren($('reference-list'), el('div', {}, list.map(reference => el('div', {class: 'ref', 'data-key': reference.id},
    el('div', {class: 'row-head'}, el('strong', {text: name(reference)}), opButton('×', 'reference.remove', () => mutate('reference.remove', {id: reference.id}, 'Reference removed.'), {class: 'plain', 'aria-label': 'Remove ' + name(reference)})),
    el('p', {text: reference.uri}))), list.length ? null : caption('No references selected.')));
  $('add-reference').disabled = !state.workflowId || !can('reference.add');
  $('attach-references').disabled = !bridge.embedded || !list.length;
  $('copy-references').disabled = !list.length;
  $('clear-references').disabled = !list.length || !can('reference.remove');
}
async function attachReferences() {
  const batch = state.references.map(reference => ({...reference}));
  referenceQueue = referenceQueue.catch(() => {}).then(async () => {
    await bridge.updateReferences(batch);
    $('reference-status').textContent = 'Added to the conversation. Send your message when ready.';
  });
  try { await referenceQueue; } catch (error) { $('reference-status').textContent = error.message + ' Use Copy to include these references yourself.'; }
}

// ---------- page frame ----------
function view(tab = state.tab) { return state.views[tab] ||= views[tab].create(); }
function setOptions(node, list, value, placeholder) {
  morphChildren(node, el('select', {}, el('option', {value: '', text: placeholder}), list.map(item => el('option', {value: item.id, text: name(item)}))));
  if (node.value !== value) node.value = value;
}
function renderSelectors() {
  const projects = [...(state.projectResults || state.snapshot.projects || [])], active = selectedProject();
  if (active && !projects.some(project => project.id === active.id)) projects.unshift(active);
  setOptions($('project'), projects, state.projectId, 'Choose a project');
  setOptions($('workflow'), (state.snapshot.workflows || []).filter(item => item.projectId === state.projectId), state.workflowId, 'Project overview');
  $('workflow').disabled = !state.projectId;
  $('new-workflow').disabled = !state.projectId || !can('workflow.create');
  $('instance').textContent = 'Workbench' + (state.snapshot.instance?.version ? ' · ' + state.snapshot.instance.version : '') + (state.snapshot.access?.profile === 'full' ? ' · Full access' : '');
  const viewer = state.snapshot.viewer;
  $('viewer').textContent = viewer ? [viewer.displayName || viewer.id, viewer.role].filter(Boolean).join(' · ') : '';
  $('scope').textContent = state.projectId ? [name(selectedProject()) || state.projectId, name(selectedWorkflow())].filter(Boolean).join(' / ') : 'No project selected';
}
function buildTabs() {
  $('tabs').replaceChildren(...TABS.map(tab => el('button', {type: 'button', role: 'tab', id: 'tab-' + tab.toLowerCase(), 'aria-controls': 'panel', 'data-tab': tab,
    onclick: () => changeTab(tab), onkeydown: tabKey}, el('span', {text: tab}), el('span', {class: 'count', hidden: true}))));
}
// Arrow keys move between tabs; Enter or Space opens the focused one.
function tabKey(event) {
  const tabs = [...$('tabs').children], index = tabs.indexOf(event.currentTarget);
  const target = {ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1}[event.key];
  if (target === undefined) return;
  event.preventDefault(); tabs[(target + tabs.length) % tabs.length].focus();
}
function renderTabs() {
  const waiting = state.snapshot.counts?.pendingReviews || 0;
  for (const node of $('tabs').children) {
    const selected = node.dataset.tab === state.tab;
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    if (node.dataset.tab !== 'Approvals') continue;
    node.lastChild.hidden = !waiting; node.lastChild.textContent = waiting ? String(waiting) : '';
    if (waiting) node.setAttribute('aria-label', 'Approvals, ' + waiting + ' waiting'); else node.removeAttribute('aria-label');
  }
  $('panel').setAttribute('aria-labelledby', 'tab-' + state.tab.toLowerCase());
}
// The view root is keyed by tab and project: moving to another one starts from fresh nodes, while
// every other render patches the nodes on screen and so never destroys what the person is using.
function renderMain() {
  renderTabs();
  const ready = state.projectId || state.tab === 'Overview', definition = views[state.tab];
  const body = ready ? definition.render(view()) : [empty('Choose a project', 'Select a project above to see its ' + state.tab.toLowerCase() + '.')];
  morphChildren($('panel'), el('div', {}, el('div', {'data-key': state.tab + '\n' + state.projectId}, body)));
  if (ready) definition.after?.(view());
}
function renderDisplay() {
  const full = bridge.displayMode === 'fullscreen', node = $('display');
  root.dataset.display = bridge.displayMode;
  node.hidden = !bridge.embedded || !bridge.canDisplay(full ? 'inline' : 'fullscreen');
  node.textContent = full ? 'Exit full screen' : 'Full screen';
}
function renderTheme() {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('theme').textContent = dark ? 'Light appearance' : 'Dark appearance';
  return dark;
}
async function loadView() {
  if (!state.projectId && state.tab !== 'Overview') return;
  try { await views[state.tab].load(view()); } catch (error) { fail(error); }
}
async function changeTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab; renderMain();
  await loadView(); renderMain();
}
async function changeScope(projectId, workflowId, discard = false) {
  const moving = projectId !== state.projectId, files = state.views.Files;
  if (moving && !discard && files && !await leaveFile(files)) { renderSelectors(); return; }
  state.projectId = projectId; state.workflowId = workflowId; state.projectResults = null; state.generation++;
  // What belongs to the project (an open file, a command line) survives a change of workflow.
  for (const tab of Object.keys(state.views)) if (moving || views[tab].scope !== 'project') delete state.views[tab];
  state.references = []; notice();
  renderSelectors(); renderReferences(); renderMain();
  await refresh();
}
// One refresh runs at a time; requests that arrive meanwhile are answered by one more run.
let refreshing = null, again = false;
function refresh() {
  if (state.disposed || state.expired) return Promise.resolve();
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do { again = false; await refreshOnce(); } while (again && !state.disposed && !state.expired);
  })().finally(() => { refreshing = null; });
  return refreshing;
}
async function refreshOnce() {
  const generation = state.generation;
  lastRefresh = Date.now();
  try {
    const snapshot = await call('workbench.snapshot', scope());
    if (generation !== state.generation) { again = true; return; }
    state.snapshot = snapshot;
  } catch (error) {
    if (generation !== state.generation) { again = true; return; }
    if (error.code === 'unreachable') setConnection('Not responding', true);
    fail(error); return;
  }
  setConnection(connectedText());
  $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  renderSelectors(); renderTabs();
  await Promise.all([loadReferences(), loadView()]);
  if (generation !== state.generation) { again = true; return; }
  renderReferences(); renderMain();
}
// Work that may need the person soon: used to keep an embedded workbench, which gets no event stream, current.
function watching() {
  return (state.snapshot.agents || []).some(agent => ['starting', 'running', 'waiting', 'cancelling'].includes(agent.status)) ||
    (state.snapshot.counts?.pendingReviews || 0) > 0 || Object.values(state.views.Agents?.results || {}).some(result => !result.settled);
}
function tick() {
  if (state.disposed || state.expired || document.hidden) return;
  const commands = state.tab === 'Commands' ? state.views.Commands : null, pace = bridge.embedded ? 10000 : 2000;
  // Command output is not announced by events, so the newest page of a running command is read on a timer.
  if (commands?.selected && commands.tail && commands.page?.status === 'running' && Date.now() - commands.readAt >= pace) void readOutput(commands).then(repaint);
  if (bridge.embedded && watching() && Date.now() - lastRefresh >= 10000) void refresh();
}
// An event only says that something changed; what changed is always fetched again.
function scheduleRefresh() {
  if (refreshTimer || state.disposed || state.expired || document.hidden) return;
  // The overview and the changes are read from Git on every refresh: while events arrive in a stream they are
  // refreshed at a slower pace than the pages that only read DevMate's own state.
  const pace = ['Overview', 'Changes'].includes(state.tab) ? 3000 : 1000;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, Math.max(250, pace - (Date.now() - lastRefresh)));
}
async function connectFeed() {
  if (feed || state.disposed || state.expired) return;
  const current = feed = new AbortController();
  let retry = 3000, refusal = null;
  try {
    await bridge.listen({signal: current.signal, onRetry: ms => { retry = ms; },
      onOpen: () => { if (feedLost) { feedLost = false; setConnection(connectedText()); void refresh(); } },
      onEvent: data => {
        let projectId;
        try { projectId = JSON.parse(data).projectId; } catch {}
        if (!projectId || projectId === state.projectId) scheduleRefresh();
      }});
  } catch (error) { refusal = error.code === 'session_expired' || error.code === 'refused' ? error : null; }
  if (feed !== current) return; // closed on purpose
  feed = null; feedLost = true;
  if (refusal?.code === 'session_expired') return expire();
  if (!refusal) { setConnection('Reconnecting…', true); setTimeout(connectFeed, retry); return; }
  // The stream was refused rather than interrupted. One ordinary call tells whether DevMate still answers.
  call('workbench.snapshot', scope()).then(() => setConnection(connectedText()), error => { if (error.code !== 'session_expired') setConnection('Not responding', true); })
    .finally(() => setTimeout(connectFeed, 5000));
}
function dispose() {
  state.disposed = true; feed?.abort(); feed = null; clearTimeout(refreshTimer);
  setTimeout(() => bridge.dispose(), 0);
}

// ---------- fixed controls ----------
const press = (id, action) => $(id).addEventListener('click', event => { event.preventDefault(); act(event.currentTarget, action, event); });
$('project').addEventListener('change', event => changeScope(event.target.value, '').catch(fail));
$('workflow').addEventListener('change', event => changeScope(state.projectId, event.target.value).catch(fail));
press('new-workflow', createWorkflow);
press('refresh', refresh);
press('display', async () => { await bridge.requestDisplayMode(bridge.displayMode === 'fullscreen' ? 'inline' : 'fullscreen'); renderDisplay(); });
press('operations', async () => {
  const result = await call('operations.list', {summary: true});
  dialog('Available operations', (result.items || []).map(item => el('div', {class: 'entry'}, el('div', {class: 'row-head'}, el('strong', {text: item.name}), item.readOnly ? badge('reads only', '') : null), el('p', {text: item.description}))));
});
press('theme', () => { root.dataset.theme = renderTheme() ? 'light' : 'dark'; renderTheme(); });
press('project-find', async () => {
  const query = $('project-query').value, generation = state.generation;
  state.query = query;
  const result = await call('project.list', {query, limit: 100});
  if (generation !== state.generation || state.query !== query) return;
  state.projectResults = result.items || []; renderSelectors();
  notice(result.nextCursor ? 'Showing the first 100 matching projects. Narrow the search to find others.' : state.projectResults.length + ' matching project(s) are in the project list.');
});
press('add-reference', () => {
  const draft = {name: '', uri: ''};
  dialog('Add reference', [label('Name', input(draft, 'name')), label('Resource URI', input(draft, 'uri', {placeholder: 'devmate://… or https://…'}))], 'Add', () => {
    const uri = required(draft.uri, 'a resource URI');
    return addReference({uri, name: draft.name.trim() || uri});
  });
});
press('attach-references', attachReferences);
press('copy-references', async () => {
  const text = contextText(state.references);
  try { await navigator.clipboard.writeText(text); $('reference-status').textContent = 'References copied.'; }
  catch { dialog('Copy references', [el('textarea', {'aria-label': 'References to copy', readOnly: true, value: text})]); }
});
press('clear-references', async () => {
  for (const reference of [...state.references]) await mutate('reference.remove', {id: reference.id}, 'References cleared.');
});
press('alert-dismiss', () => notice());
press('session-reload', () => location.reload());
press('dialog-close', () => $('dialog').close());
for (const id of ['dialog', 'confirm']) {
  $(id).addEventListener('close', () => closed($(id)));
  $(id).querySelector('form').addEventListener('submit', event => event.preventDefault());
}
$('project-search').addEventListener('submit', event => event.preventDefault());
addEventListener('beforeunload', event => { if (dirty(state.views.Files?.file)) { event.preventDefault(); event.returnValue = ''; } });

async function boot() {
  bridge = new DevMateBridge.Bridge({
    onContext: context => {
      if (context.theme) { root.dataset.theme = context.theme; renderTheme(); }
      if (Object.prototype.hasOwnProperty.call(context, 'openai/modelContext') && context['openai/modelContext'] === null) {
        $('reference-status').textContent = 'The references were removed from the conversation. They are still saved here.';
      }
      renderDisplay();
    }, onTeardown: dispose
  });
  buildTabs(); renderTheme();
  if (bridge.embedded) root.dataset.embedded = '';
  try {
    await bridge.connect();
    renderDisplay();
    // The official request; a host that does not offer fullscreen keeps the workbench inline, where it works the same.
    if (bridge.displayMode !== 'fullscreen') void bridge.requestDisplayMode('fullscreen').then(renderDisplay, () => {});
    const initial = await bridge.initialResult();
    // The opening call says what was asked for; the data itself is loaded below.
    if (initial?.selection) { state.projectId = initial.selection.projectId || ''; state.workflowId = initial.selection.workflowId || ''; }
    renderSelectors(); renderReferences(); renderMain();
    await refresh();
    if (!bridge.embedded) void connectFeed();
    setInterval(tick, 2000);
    // Without an event stream (inside a host) and after time away, looking at the page again is what refreshes it.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
    addEventListener('focus', () => { if (Date.now() - lastRefresh > 2000) void refresh(); });
  } catch (error) {
    fail(error); setConnection('Unavailable', true);
    $('panel').replaceChildren(empty('Cannot connect to DevMate', error.message, [button('Reload', () => location.reload())]));
  }
}
boot();
})();
