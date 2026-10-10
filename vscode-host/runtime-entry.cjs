'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createHostClient } = require('../runtime/host-client.cjs');

const POLL_MS = 15_000;
const MAX_DIAGNOSTICS = 1000;
const DECLINED_KEY = 'devMate.declinedFolders';
const NOTIFIED_KEY = 'devMate.sharingNotified';
// What devMate.shareFolders means for a folder nobody has decided about yet.
const SHARING = { readWrite: 'write', readOnly: 'read', ask: null, never: null };
const ACCESS_LABEL = { write: 'read and write', read: 'read only' };
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(a) === pathKey(b);

function createVscodeRuntimeEntry(vscode, { client: suppliedClient, clientFactory = createHostClient, clock = Date.now } = {}) {
  // This identity lives only inside one VS Code extension host (one editor
  // window). It never becomes a machine-wide "active workspace". Any number of
  // windows, other editors and the CLI share one runtime; each window keeps its
  // own folders and its own selected project.
  const windowId = randomUUID();
  let client, active = false, subscription, poll, refreshTimer, changes, output, statusBar, mcpChanged, memory;
  let refreshPromise, rerun = false, attachment = null, rememberedRoot = null, boundKey = '', boundGeneration = '', seenAt = 0;
  let state = { state: 'stopped', running: false }, contextTimer, publishedContext = '', asking = false, updateOffered = false, servedMcp = '', pendingConnection = '';
  const declined = new Set(), recoveries = [], announced = new Set();

  function folders() {
    const all = vscode.workspace.workspaceFolders || [];
    const trusted = vscode.workspace.isTrusted !== false && all.every(folder => folder.uri?.scheme === 'file');
    return { trusted, roots: trusted ? all.map(folder => ({
      root: folder.uri.fsPath, name: folder.name || folder.uri.fsPath
    })) : [] };
  }
  const settings = () => vscode.workspace.getConfiguration('devMate');
  function treeItem(label, command, description = '', args) {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    if (command) item.command = { command, title: label, ...(args ? { arguments: args } : {}) };
    return item;
  }
  const connectionNote = () => state.health?.connection === 'failed' ? 'connection failed' : state.outdated ? 'older version running, restart to update'
    : pendingConnection && pendingConnection === state.record?.generation ? 'restart to apply the saved connection' : '';
  const provider = {
    getTreeItem: item => item,
    getChildren() {
      // While nothing runs the view lists nothing, and the editor shows its welcome text with the Start button instead.
      // What can be done is in the title bar of the view and in the status bar menu, not in rows that pose as buttons.
      if (!state.running) return [];
      const items = [treeItem('Runtime', 'devMate.runtime.menu', [state.state, connectionNote()].filter(Boolean).join(', '))];
      for (const folder of attachment?.roots || []) {
        items.push(folder.projectId
          ? treeItem(folder.name, 'devMate.runtime.selectWorkspace', 'Shared, ' + (ACCESS_LABEL[folder.access] || 'shared') + (folder.projectId === attachment.selectedProjectId ? ' · this window' : ' · click to switch'), [folder.projectId])
          : treeItem(folder.name, 'devMate.runtime.registerFolder', folder.reason ? 'Not shared: ' + folder.reason : 'Not shared with DevMate — click to share', [folder.opened || folder.root]));
      }
      if (attachment?.roots.length) items.push(treeItem('Folder sharing…', 'devMate.runtime.registerFolder'));
      return items;
    }
  };
  let shownRunning;
  function report(error) { output?.appendLine(error?.message || String(error)); }
  async function showError(error) {
    report(error);
    const action = error?.code === 'NODE_REQUIRED' ? 'Open Settings' : error?.code === 'RUNTIME_STOPPED' ? 'Start DevMate'
      : /Port \d+ on 127\.0\.0\.1 is already used/.test(error?.message || '') ? 'Choose Another Port' : null;
    const picked = await vscode.window.showErrorMessage(error?.message || String(error), ...(action ? [action] : []));
    if (picked === 'Open Settings') await vscode.commands.executeCommand?.('workbench.action.openSettings', 'devMate.nodeCommandPath');
    if (picked === 'Choose Another Port') await vscode.commands.executeCommand?.('workbench.action.openSettings', 'devMate.runtimePort');
    if (picked === 'Start DevMate') await vscode.commands.executeCommand?.('devMate.runtime.start');
  }
  function render() {
    if (statusBar) {
      const note = connectionNote();
      statusBar.text = (state.running ? (note ? '$(warning)' : '$(plug)') : '$(circle-slash)') + ' DevMate';
      statusBar.tooltip = 'DevMate runtime: ' + state.state + (note ? ' (' + note + ')' : '') +
        (state.running ? '\nPort ' + state.record?.port + (attachment?.selectedProjectId ? ''
          : attachment?.roots.some(folder => folder.projectId) ? '\nSeveral folders are shared: choose the one this window works in (DevMate: Select This Window Workspace)' : '\nThis window shares no folder') +
          '\nIt keeps running after this window closes, until you stop it' : '\nClick to start');
      statusBar.command = state.running ? 'devMate.runtime.menu' : 'devMate.runtime.start';
    }
    // The title bar of the view and its welcome text follow this.
    if (shownRunning !== state.running) { shownRunning = state.running; void Promise.resolve(vscode.commands.executeCommand?.('setContext', 'devMate.running', state.running === true)).catch(() => {}); }
    // Language-model features of the editor learn about the local MCP endpoint only while it exists.
    const serving = state.running ? String(state.record?.port) : '';
    if (serving !== servedMcp) { servedMcp = serving; mcpChanged?.fire(); }
    if (active) changes?.fire();
  }

  // What the user has in front of them: active file, selection, open files and
  // the diagnostics their language tooling already computed. Published to the
  // runtime on change so a connected model can see errors without running a build.
  function editorContext() {
    if (settings().get('shareEditorContext', true) === false) return { active: null, open: [], diagnostics: [] };
    const editor = vscode.window.activeTextEditor, document = editor?.document;
    const activeFile = document?.uri?.scheme === 'file' ? {
      file: document.uri.fsPath, languageId: document.languageId, dirty: document.isDirty === true, lineCount: document.lineCount,
      selection: { startLine: editor.selection.start.line, startCharacter: editor.selection.start.character,
        endLine: editor.selection.end.line, endCharacter: editor.selection.end.character },
      selectedText: editor.selection.isEmpty ? '' : document.getText(editor.selection).slice(0, 20001)
    } : null;
    const open = (vscode.workspace.textDocuments || []).filter(item => item.uri?.scheme === 'file' && !item.isClosed)
      .slice(0, 200).map(item => ({ file: item.uri.fsPath, dirty: item.isDirty === true }));
    // Each severity keeps its own share, so a flood of hints can never crowd out an error.
    const severities = ['error', 'warning', 'info', 'hint'], kept = { error: [], warning: [], info: [], hint: [] };
    for (const [uri, items] of vscode.languages?.getDiagnostics?.() || []) {
      if (uri.scheme !== 'file') continue;
      for (const item of items) {
        const severity = severities[item.severity] || 'info';
        if (kept[severity].length >= MAX_DIAGNOSTICS) continue;
        kept[severity].push({ file: uri.fsPath, severity, line: item.range.start.line,
          character: item.range.start.character, message: item.message, source: item.source,
          code: item.code && typeof item.code === 'object' ? item.code.value : item.code });
      }
    }
    // With several windows open, "the project in front of the user" is the one whose window has the focus.
    return { active: activeFile, open, diagnostics: severities.flatMap(severity => kept[severity]).slice(0, MAX_DIAGNOSTICS), focused: vscode.window.state?.focused !== false };
  }
  async function publishContext() {
    if (!active || !state.running || !attachment) return;
    const context = editorContext(), fingerprint = JSON.stringify(context);
    if (fingerprint === publishedContext) return;
    await client.call('window.context', { windowId, context });
    publishedContext = fingerprint;
  }
  function scheduleContext(delay = 400) {
    if (!active || contextTimer) return;
    contextTimer = setTimeout(() => { contextTimer = undefined; void publishContext().catch(report); }, delay);
  }
  function scheduleRefresh() {
    if (!active || refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void refresh().catch(report);
    }, 75);
  }
  // An agent that waits for a decision is waiting for the person at this editor.
  function announce(event) {
    const data = event?.data, entity = data?.entity;
    // Sharing changed somewhere (the workbench, another window, the command line): show it now, not at the next poll.
    if (typeof data?.type === 'string' && data.type.startsWith('project.')) { seenAt = 0; scheduleRefresh(); return; }
    // The stream carries every project; only what happens in this window's own folders concerns the person at it.
    if (!attachment?.roots.some(folder => folder.projectId && folder.projectId === data?.projectId)) return;
    if (!['approval.created', 'input.created'].includes(data?.type) || entity?.status !== 'pending' || announced.has(entity.id)) return;
    announced.add(entity.id);
    void Promise.resolve(vscode.window.showInformationMessage?.(
      (data.type === 'approval.created' ? 'An agent is waiting for your approval' : 'An agent is asking you a question') +
        (typeof entity.summary === 'string' ? ': ' + entity.summary.slice(0, 200) : '.'), 'Open Workbench'))
      .then(picked => picked === 'Open Workbench' ? vscode.commands.executeCommand?.('devMate.runtime.open') : undefined).catch(report);
  }
  function renewSubscription() {
    subscription?.dispose();
    subscription = client.subscribe(announce, error => {
      report(error);
      // The restarted service does not know this extension-host window yet.
      // Reattach on a bounded failure rather than waiting for the next poll.
      scheduleRefresh();
    }, scheduleRefresh, { scoped: false });
  }
  function adopt(next, fingerprint, generation) {
    attachment = next;
    rememberedRoot = selectedFolder(next);
    boundKey = fingerprint;
    boundGeneration = generation;
    seenAt = clock();
    // A new attachment starts without editor state; publish it again.
    publishedContext = '';
    scheduleContext(0);
    // A window with several shared folders has no selection until its user chooses, and still hears about every one of them.
    if (sharesAny()) renewSubscription();
    else { subscription?.dispose(); subscription = null; }
  }
  const sharesAny = () => !!attachment?.roots.some(folder => folder.projectId);
  // The selected folder as this window spells it, which is how it is found again after a runtime restart.
  function selectedFolder(value) {
    const folder = value?.roots?.find(root => root.projectId && root.projectId === value.selectedProjectId);
    return folder ? folder.opened || folder.root : null;
  }
  // The editor ships its own ripgrep. Offering it to the runtime means that finding and
  // searching files works without installing anything; a ripgrep on PATH still comes first.
  function bundledTools() {
    const app = vscode.env?.appRoot;
    if (typeof app !== 'string' || !app) return {};
    // Newer editors keep one folder per platform and processor; only the one for this machine is right.
    const name = process.platform === 'win32' ? 'rg.exe' : 'rg', target = process.platform + '-' + process.arch;
    const rg = ['node_modules.asar.unpacked', 'node_modules'].flatMap(modules => [
      path.join(app, modules, '@vscode', 'ripgrep-universal', 'bin', target, name),
      path.join(app, modules, '@vscode', 'ripgrep', 'bin', name)
    ]).find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
    return rg ? { tools: { rg } } : {};
  }
  // chosen: the person at this window decided, as opposed to the default applying. Only that shares a folder taken out earlier.
  async function attach(info, register = {}, chosen = false) {
    const selectedRoot = rememberedRoot && info.roots.some(root => samePath(root.root, rememberedRoot)) ? rememberedRoot : undefined;
    return client.call('window.attach', { windowId, title: vscode.workspace.name || 'VS Code window', trusted: info.trusted,
      roots: info.roots.map(root => register[root.root] ? { ...root, register: register[root.root], ...(chosen ? { chosen: true } : {}) } : root),
      ...(selectedRoot ? { selectedRoot } : {}), ...bundledTools() });
  }
  // Folder sharing. By default a trusted folder opened in this editor is shared with
  // connected AI clients, read and write, and the window says so once. The owner can
  // change that for a folder at any time (read only, or not shared) and can change the
  // default with the devMate.shareFolders setting. An untrusted workspace is never shared.
  const sharingMode = () => { const mode = settings().get('shareFolders', 'readWrite'); return Object.hasOwn(SHARING, mode) ? mode : 'readWrite'; };
  const recalled = key => new Set(memory?.get(key, []) || []);
  const isDeclined = root => declined.has(pathKey(root)) || recalled(DECLINED_KEY).has(pathKey(root));
  async function decline(root, persist) {
    declined.add(pathKey(root));
    if (persist) await memory?.update(DECLINED_KEY, [...recalled(DECLINED_KEY).add(pathKey(root))]);
  }
  async function undecline(root) {
    declined.delete(pathKey(root));
    const kept = recalled(DECLINED_KEY);
    if (kept.delete(pathKey(root))) await memory?.update(DECLINED_KEY, [...kept]);
  }
  const spelled = folder => folder.opened || folder.root;
  async function bindWindow(generation) {
    const info = folders(), fingerprint = JSON.stringify(info);
    if (attachment && boundKey === fingerprint && boundGeneration === generation && clock() - seenAt < 60_000) return;
    if (attachment && boundKey === fingerprint && boundGeneration === generation) {
      try {
        // The answer carries what is shared now: access changed or a folder taken out elsewhere shows up here.
        const view = await client.call('window.heartbeat', {windowId});
        if (Array.isArray(view?.roots)) { attachment = view; rememberedRoot = selectedFolder(view) || rememberedRoot; }
        seenAt = clock();
        return;
      } catch (error) {
        if (error.code !== 'window_missing') throw error;
      }
    }
    // What this window shares on its own: every folder its owner has not taken out, at the default access.
    const access = SHARING[sharingMode()];
    const register = access ? Object.fromEntries(info.roots.filter(root => !isDeclined(root.root)).map(root => [root.root, access])) : {};
    adopt(await attach(info, register), fingerprint, generation);
    void settleSharing().catch(report);
  }
  async function shareFolder(root, access) {
    const info = folders();
    const folder = info.roots.find(item => samePath(item.root, root));
    if (!folder) throw new Error('This folder is not open in this window.');
    await undecline(folder.root);
    adopt(await attach(info, { [folder.root]: access }, true), JSON.stringify(info), boundGeneration);
    render();
  }
  async function settleSharing() {
    if (!active || !attachment || typeof vscode.window.showInformationMessage !== 'function') return;
    if (sharingMode() === 'ask') return askSharing();
    // Sharing by default is never silent: each shared folder is named once, with the way to change it.
    const told = recalled(NOTIFIED_KEY);
    for (const folder of attachment.roots.filter(item => item.projectId && !told.has(pathKey(spelled(item))))) {
      // Said once, with the first folder: closing the editor does not end what was started here.
      const first = told.size === 0;
      told.add(pathKey(spelled(folder)));
      await memory?.update(NOTIFIED_KEY, [...told]);
      void Promise.resolve(vscode.window.showInformationMessage('DevMate shares "' + folder.name + '" with connected AI clients (' + (ACCESS_LABEL[folder.access] || 'shared') + ').' +
        (first ? ' DevMate keeps running after you close this window, until you stop it (DevMate: Stop DevMate Runtime).' : ''), 'Change…'))
        .then(picked => picked === 'Change…' ? changeSharing(spelled(folder)) : undefined).catch(report);
    }
  }
  async function askSharing() {
    if (asking) return;
    const pending = attachment.roots.filter(folder => !folder.projectId && !isDeclined(spelled(folder)));
    if (!pending.length) return;
    asking = true;
    try {
      for (const folder of pending) {
        const answer = await vscode.window.showInformationMessage(
          'Let AI clients connected to DevMate work in "' + folder.name + '"? They can then read its files' +
          ', and with write access change them and run commands.', 'Read and write', 'Read only', 'Don\'t share');
        if (!active) return;
        if (answer === 'Read and write' || answer === 'Read only') await shareFolder(spelled(folder), answer === 'Read only' ? 'read' : 'write');
        // "Don't share" is remembered for this workspace; closing the notification only postpones the question.
        else await decline(spelled(folder), answer === 'Don\'t share');
      }
    } finally { asking = false; }
  }
  // The owner's later word on one folder of this window: read and write, read only, or not shared.
  async function changeSharing(root) {
    if (!attachment) {
      if (state.running) await vscode.window.showInformationMessage?.('DevMate could not read the folders of this window. The "DevMate Runtime" output channel has the reason.');
      else if (await vscode.window.showInformationMessage?.('DevMate is not running.', 'Start DevMate') === 'Start DevMate') await vscode.commands.executeCommand?.('devMate.runtime.start');
      return;
    }
    // Decide on what is true now, not on what this window last saw.
    const live = await client.call('window.heartbeat', {windowId}).catch(() => null);
    if (Array.isArray(live?.roots)) attachment = live;
    let folder = root ? attachment.roots.find(item => samePath(spelled(item), root) || samePath(item.root, root)) : null;
    if (!folder) {
      if (!attachment.roots.length) { await vscode.window.showInformationMessage?.('This window has no local folder open.'); return; }
      folder = attachment.roots.length === 1 ? attachment.roots[0] : (await vscode.window.showQuickPick(attachment.roots.map(item => (
        { label: item.name, description: item.projectId ? 'Shared, ' + (ACCESS_LABEL[item.access] || 'shared') : 'Not shared', folder: item })), { placeHolder: 'Which folder of this window?' }))?.folder;
      if (!folder) return;
    }
    const current = folder.projectId ? folder.access || 'write' : 'none';
    const choice = await vscode.window.showQuickPick([
      { label: 'Read and write', description: 'AI clients can read and change files and run commands', access: 'write' },
      { label: 'Read only', description: 'AI clients can read and search, nothing else', access: 'read' },
      { label: 'Do not share', description: 'AI clients cannot reach this folder', access: 'none' }
    ].map(item => item.access === current ? { ...item, description: item.description + ' — current' } : item),
    { placeHolder: 'What may connected AI clients do in "' + folder.name + '"?' });
    if (!choice || choice.access === current) return;
    if (choice.access === 'none') {
      const confirmed = await vscode.window.showWarningMessage('Stop sharing "' + folder.name + '" with AI clients?',
        { modal: true, detail: 'Its files are not touched. DevMate\'s own records for this folder (tasks, agent sessions and the history of changes made through DevMate) are removed.' }, 'Stop sharing');
      if (confirmed !== 'Stop sharing') return;
      // A decision about sharing is the owner's, whichever project this window currently works on.
      await client.call('project.remove', { id: folder.projectId }, { scoped: false });
      await decline(spelled(folder), true);
    } else if (!folder.projectId) return shareFolder(spelled(folder), choice.access);
    else await client.call('project.update', { id: folder.projectId, access: choice.access }, { scoped: false });
    boundKey = '';
    await refresh();
  }
  // How much a client connected as the owner may decide: guarded (the default) or full access.
  async function accessProfile() {
    const current = (await client.call('access.read', {}, { scoped: false })).profile;
    const choice = await vscode.window.showQuickPick([
      { label: 'Guarded', description: 'You share folders, lift credential-file protection and answer agents at this computer', profile: 'guarded' },
      { label: 'Full access', description: 'Your connected AI client does all of that; agent permission requests are granted automatically', profile: 'full' }
    ].map(item => item.profile === current ? { ...item, description: item.description + ' — current' } : item),
    { placeHolder: 'What may an AI client connected as you decide?' });
    if (!choice || choice.profile === current) return current;
    if (choice.profile === 'full') {
      const confirmed = await vscode.window.showWarningMessage('Give connected AI clients full access?',
        { modal: true, detail: 'A client connected as you can then share any folder of this computer, read credential files such as .env, set up capability engines and answer what a delegated agent asks. ' +
          'What a delegated agent asks permission for is granted automatically. Keep your MCP address private, or require sign-in. You can switch back at any time.' }, 'Switch on full access');
      if (confirmed !== 'Switch on full access') return current;
    }
    await client.call('access.update', { profile: choice.profile }, { scoped: false });
    vscode.window.setStatusBarMessage?.('DevMate: ' + (choice.profile === 'full' ? 'full access is on' : 'guarded profile'), 5000);
    return choice.profile;
  }
  // A runtime that vanished without a clean stop is started again when this
  // editor is set to keep it up. An explicit stop is respected: it leaves no trace to recover from.
  async function recover() {
    if (!state.crashed || !settings().get('autoStart', false) || !folders().roots.length) return;
    const now = clock();
    while (recoveries.length && now - recoveries[0] > 600_000) recoveries.shift();
    if (recoveries.length >= 3) return;
    recoveries.push(now);
    report(new Error('The DevMate runtime stopped unexpectedly; starting it again.'));
    await client.start();
    state = await client.status();
  }
  async function offerUpdate() {
    if (!state.outdated || updateOffered || typeof vscode.window.showInformationMessage !== 'function') return;
    updateOffered = true;
    const picked = await vscode.window.showInformationMessage('The running DevMate runtime is version ' + (state.record?.version || 'unknown') +
      '; this extension ships ' + state.host?.version + '. Restart the shared runtime to use the new version? Other windows and connected clients reconnect.', 'Restart');
    if (picked === 'Restart') await restart().catch(showError);
  }
  async function refreshOnce() {
    if (!active) return state;
    const observed = await client.status();
    if (!active) return observed;
    state = observed;
    if (!state.running) await recover().catch(report);
    if (state.running) {
      // A problem with this window's folders is reported, and the window still shows the runtime it is connected to.
      try { await bindWindow(state.record?.generation || 'injected-runtime'); }
      catch (error) { render(); throw error; }
      if (sharesAny() && !subscription) renewSubscription();
      if (!sharesAny() && subscription) { subscription.dispose(); subscription = null; }
      void offerUpdate().catch(report);
    } else {
      attachment = null;
      boundGeneration = '';
      boundKey = '';
      subscription?.dispose();
      subscription = null;
    }
    render();
    return state;
  }
  async function refresh() {
    if (refreshPromise) { rerun = true; return refreshPromise; }
    refreshPromise = (async () => {
      do { rerun = false; await refreshOnce(); } while (active && rerun);
      return state;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function selectWorkspace(projectId) {
    if (!projectId) {
      const selected=await vscode.window.showQuickPick(
        (attachment?.roots||[]).filter(folder=>folder.projectId).map(folder=>({label:folder.name,description:folder.root,projectId:folder.projectId})),
        {placeHolder:'Choose this VS Code window workspace'});
      if (!selected) return;
      projectId=selected.projectId;
    }
    if (!attachment?.roots.some(folder => folder.projectId === projectId)) throw new Error('Select a folder belonging to this VS Code window.');
    attachment = await client.call('window.select', {windowId,projectId});
    rememberedRoot = selectedFolder(attachment);
    renewSubscription();
    await refresh();
  }
  async function showOperations(invoke) {
    const result = await client.operations();
    const selected = await vscode.window.showQuickPick(
      result.items.map(operation => ({label:operation.name,description:operation.description || '',operation})),
      { placeHolder: invoke ? 'Choose a DevMate operation' : 'Discover every DevMate operation' }
    );
    if (!selected) return;
    if (!invoke) {
      output.appendLine(JSON.stringify(selected.operation,null,2));output.show();return;
    }
    const raw = await vscode.window.showInputBox({title:selected.label,prompt:'JSON object input',value:'{}'});
    if (raw === undefined) return;
    let input;
    try { input = JSON.parse(raw); } catch { throw new Error('The input is not valid JSON.'); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object');
    const value = await client.call(selected.label,input);
    output.appendLine(JSON.stringify(value,null,2));output.show();
    await refresh();
  }
  async function doctor() {
    const result = await client.call('runtime.doctor', {});
    output.appendLine('DevMate ' + result.version + ' — ' + result.status);
    for (const item of result.checks) {
      output.appendLine('[' + item.status + '] ' + item.id + ': ' + item.detail);
      if (item.fix && item.status !== 'ok') output.appendLine('    -> ' + item.fix);
    }
    output.show();
    return result;
  }
  async function copyMcpUrl() {
    const connection = await client.call('connection.status', {});
    const value = connection.publicUrl || connection.url || connection.tunnelId || await client.mcpUrl();
    await vscode.env.clipboard.writeText(value);
    await vscode.window.showInformationMessage(connection.tunnelId ? 'Copied the tunnel ID. In ChatGPT choose the Tunnel connection type.'
      : connection.publicUrl || connection.url ? 'Copied the public MCP URL.'
        // In a remote window the extension, and with it DevMate, runs on the remote computer.
        : 'Copied the local MCP URL' + (vscode.env.remoteName ? ' of the remote computer this window works on (' + vscode.env.remoteName + '); it answers there, not on this computer' : '') +
          '. Cloud clients need a public connection: run "DevMate: Configure Connection".');
    return value;
  }
  async function loginCode() {
    const configured = await client.call('settings.read', {});
    if ((configured.active || configured.saved)?.auth?.mode !== 'oauth') {
      const picked = await vscode.window.showInformationMessage('Sign-in is off for this DevMate, so there is no code to copy. To require sign-in, configure the connection and choose "Require sign-in".', 'Configure Connection');
      if (picked === 'Configure Connection') await vscode.commands.executeCommand?.('devMate.runtime.configureConnection');
      return;
    }
    const issued = await client.call('auth.code.create', {});
    await vscode.env.clipboard.writeText(issued.code);
    await vscode.window.showInformationMessage('Copied a one-time sign-in code. Paste it on the DevMate authorization page; it expires in 10 minutes.');
  }
  async function restart() {
    await client.stop();
    await client.start();
    return refresh();
  }
  // Guided setup for the one decision that otherwise needs hand-edited JSON:
  // how cloud clients reach this computer, and whether they must sign in.
  async function configureConnection() {
    const saved = await connectionWizard();
    // Leaving the questions at any point changes nothing, and says so.
    if (saved === undefined) vscode.window.setStatusBarMessage?.('DevMate: connection unchanged', 4000);
    return saved;
  }
  async function connectionWizard() {
    const ask = (prompt, options = {}) => vscode.window.showInputBox({ title: 'DevMate: Configure Connection', prompt, ignoreFocusOut: true, ...options });
    const hostName = value => /^(https?:\/\/)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d+)?(\/.*)?$/i.test(value.trim()) ? null : 'Enter a host name such as devmate.example.com';
    const httpsAddress = value => { try { return new URL(value.trim()).protocol === 'https:' ? null : 'The address starts with https://'; } catch { return 'Enter the full address, for example https://devmate.example.com/mcp'; } };
    const choice = await vscode.window.showQuickPick([
      { label: 'Cloudflare Tunnel', description: 'Your own domain. Works with ChatGPT, Claude and any MCP client', kind: 'cloudflare' },
      { label: 'OpenAI Secure MCP Tunnel', description: 'ChatGPT and Codex only. No domain or public address', kind: 'openai-tunnel' },
      { label: 'Existing HTTPS reverse proxy', description: 'A proxy you already run', kind: 'external-https' },
      { label: 'SSH reverse tunnel', description: 'A server of yours forwards its HTTPS address to this computer', kind: 'ssh' },
      { label: 'Local only', description: 'Remove the public connection', kind: 'local' }
    ], { placeHolder: 'How should cloud clients such as ChatGPT reach DevMate?', ignoreFocusOut: true });
    if (!choice) return;
    const saved = (await client.call('settings.read', {})).saved, current = saved.connection || {};
    const config = { ...saved };
    const was = (kind, field) => current.kind === kind ? current[field] || '' : '';
    let secret = null, publicUrl = null;
    if (choice.kind === 'local') config.connection = { kind: 'local' };
    else if (choice.kind === 'openai-tunnel') {
      const tunnelId = await ask('Tunnel ID from platform.openai.com → Settings → Tunnels', { value: was('openai-tunnel', 'tunnelId'), placeHolder: 'tunnel_…' });
      if (!tunnelId) return;
      const executable = await ask('Absolute path of the official tunnel-client executable', { value: was('openai-tunnel', 'executable') });
      if (!executable) return;
      const key = await ask('Runtime API key of the tunnel. Stored privately; leave empty to keep the stored one', { password: true });
      if (key === undefined) return;
      config.connection = { kind: 'openai-tunnel', tunnelId: tunnelId.trim(), executable: executable.trim(), runtimeKeyEnv: 'CONTROL_PLANE_API_KEY' };
      if (key.trim()) secret = ['CONTROL_PLANE_API_KEY', key];
    } else if (choice.kind === 'cloudflare') {
      const host = await ask('Public hostname of your Cloudflare tunnel', { value: current.kind === 'cloudflare' ? new URL(current.publicUrl).host : '', placeHolder: 'devmate.example.com', validateInput: hostName });
      if (!host) return;
      const executable = await ask('Absolute path of cloudflared', { value: was('cloudflare', 'executable') ||
        (process.platform === 'win32' ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe'
          : ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', '/usr/bin/cloudflared'].find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile()) || '/usr/local/bin/cloudflared') });
      if (!executable) return;
      const token = await ask('Tunnel token from the Cloudflare dashboard. Stored privately; leave empty to keep the stored one', { password: true });
      if (token === undefined) return;
      publicUrl = 'https://' + host.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '') + '/mcp';
      config.connection = { kind: 'cloudflare', publicUrl, executable: executable.trim(), tokenEnv: 'CLOUDFLARE_TUNNEL_TOKEN' };
      if (token.trim()) secret = ['CLOUDFLARE_TUNNEL_TOKEN', token];
    } else if (choice.kind === 'ssh') {
      const entered = await ask('Public HTTPS URL that your server forwards to this computer', { value: was('ssh', 'publicUrl'), placeHolder: 'https://devmate.example.com/mcp', validateInput: httpsAddress });
      if (!entered) return;
      const host = await ask('SSH host name of that server', { value: was('ssh', 'host') });
      if (!host) return;
      const user = await ask('SSH user name', { value: was('ssh', 'user') });
      if (!user) return;
      const executable = await ask('Absolute path of the ssh executable', { value: was('ssh', 'executable') ||
        (process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh') });
      if (!executable) return;
      publicUrl = entered.trim();
      config.connection = { ...(current.kind === 'ssh' ? current : {}), kind: 'ssh', publicUrl, host: host.trim(), user: user.trim(), executable: executable.trim() };
    } else {
      const entered = await ask('Public HTTPS URL of the MCP endpoint', { value: was('external-https', 'url'), placeHolder: 'https://devmate.example.com/mcp', validateInput: httpsAddress });
      if (!entered) return;
      publicUrl = entered.trim();
      // Optional: the tunnel program behind that address, for DevMate to start and keep running.
      const before = current.kind === 'external-https' ? current.command : null;
      const program = await ask('Optional: absolute path of a tunnel program DevMate should start and keep running for this address. Leave empty if the proxy runs on its own', { value: before?.executable || '' });
      if (program === undefined) return;
      let command = null;
      if (program.trim()) {
        const written = await ask('Its arguments. {port} is the local port to forward to, {host} the public host name', { value: (before?.args || []).map(word => /\s/.test(word) ? '"' + word + '"' : word).join(' '), placeHolder: 'http {port} --url https://{host}' });
        if (written === undefined) return;
        command = { executable: program.trim(), args: written.match(/"[^"]*"|\S+/g)?.map(word => word.replace(/^"|"$/g, '')) || [], ...(before?.env?.length ? { env: before.env } : {}) };
      }
      config.connection = { kind: 'external-https', url: publicUrl, ...(command ? { command } : {}) };
    }
    if (!publicUrl) config.auth = { mode: 'none' };
    else {
      // Sign-in belongs to the public address. The current choice comes first, so Enter keeps it.
      const origin = new URL(publicUrl).origin, signedIn = saved.auth?.mode === 'oauth';
      const options = [
        { label: 'Only me, no sign-in', description: 'Whoever has the address acts as you: keep it private', oauth: false },
        { label: 'Require sign-in', description: 'Each client authorizes once with a one-time code from DevMate (OAuth)', oauth: true }
      ];
      const protection = await vscode.window.showQuickPick(signedIn ? options.reverse() : options,
        { placeHolder: 'Who may use ' + origin + '?' + (signedIn ? ' Sign-in is currently required.' : ''), ignoreFocusOut: true });
      if (!protection) return;
      config.auth = protection.oauth ? { mode: 'oauth', issuer: origin, ...(signedIn && saved.auth.clients ? { clients: saved.auth.clients } : {}) } : { mode: 'none' };
    }
    // Settings are validated and saved first: a rejected configuration must not leave a stored credential behind.
    await client.call('settings.replace', { config });
    if (secret) await client.call('secret.set', { name: secret[0], value: secret[1] });
    const ingress = state.record?.ingressPort || config.ingressPort || (state.record?.port || Number(settings().get('runtimePort', 8788))) + 1;
    const answer = await vscode.window.showWarningMessage('Connection saved. Restart the shared DevMate runtime to apply it?',
      { modal: true, detail: 'Other windows and connected clients reconnect after the restart.' +
        (choice.kind === 'cloudflare' ? ' In the Cloudflare dashboard, route the hostname to http://127.0.0.1:' + ingress + '.'
          : choice.kind === 'external-https' && !config.connection.command ? ' Point your proxy at http://127.0.0.1:' + ingress + '.' : '') }, 'Restart now');
    if (answer === 'Restart now') { await restart(); await doctor(); }
    // Saved is not active until the restart: the status says so for as long as this runtime keeps running.
    else { pendingConnection = state.record?.generation || ''; render(); }
    return config;
  }
  async function menu() {
    const picked = await vscode.window.showQuickPick([
      ...(state.outdated ? [{ label: 'Restart to update the runtime', description: 'running ' + (state.record?.version || 'an older version') + ', this extension ships ' + state.host?.version, command: 'restart' }] : []),
      { label: 'Open workbench', command: 'open' }, { label: 'Copy MCP URL', command: 'copyMcpUrl' },
      { label: 'Folder sharing…', command: 'registerFolder' }, { label: 'Permission profile…', command: 'accessProfile' }, { label: 'Configure connection', command: 'configureConnection' },
      { label: 'Doctor', command: 'doctor' }, { label: 'Restart shared runtime', command: 'restart' }, { label: 'Stop shared runtime', command: 'stop' }
    ], { placeHolder: 'DevMate — ' + state.state });
    if (picked) await vscode.commands.executeCommand?.('devMate.runtime.' + picked.command);
  }
  async function activate(context) {
    active = true;
    memory = context.workspaceState || null;
    const connect = () => suppliedClient || clientFactory({
      instanceRoot: settings().get('runtimeInstanceDirectory',''),
      nodePath: settings().get('nodeCommandPath',''),
      port: settings().get('runtimePort',8788),
      windowId
    });
    client = connect();
    changes = new vscode.EventEmitter();
    provider.onDidChangeTreeData = changes.event;
    output = vscode.window.createOutputChannel('DevMate Runtime');
    context.subscriptions.push(changes,output,vscode.window.registerTreeDataProvider('devMate.runtime',provider));
    if (typeof vscode.window.createStatusBarItem === 'function') {
      statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment?.Left ?? 1, 0);
      statusBar.name = 'DevMate';
      context.subscriptions.push(statusBar);
      statusBar.show();
    }
    // Editors with built-in MCP support get the local endpoint without any manual configuration.
    if (typeof vscode.lm?.registerMcpServerDefinitionProvider === 'function' && vscode.McpHttpServerDefinition) {
      mcpChanged = new vscode.EventEmitter();
      context.subscriptions.push(mcpChanged, vscode.lm.registerMcpServerDefinitionProvider('devMate.runtime', {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: async () => state.running
          ? [new vscode.McpHttpServerDefinition('DevMate', vscode.Uri.parse(await client.mcpUrl()), {}, state.record?.version)] : []
      }));
    }
    const handlers = {
      start: async () => { await client.start(); return refresh(); },
      stop: async () => {
        const confirmation=await vscode.window.showWarningMessage(
          'Stop the shared DevMate runtime for every connected VS Code window, CLI and ChatGPT session?',
          {modal:true},'Stop shared runtime');
        if (confirmation !== 'Stop shared runtime') return;
        await client.stop();
        return refresh();
      },
      restart: async () => {
        const confirmation = await vscode.window.showWarningMessage('Restart the shared DevMate runtime? Other windows and connected clients reconnect.',
          { modal: true }, 'Restart');
        if (confirmation === 'Restart') return restart();
      },
      status: async () => { const value = await refresh(); output.appendLine(JSON.stringify(value,null,2));output.show();return value; },
      open: async () => vscode.env.openExternal(vscode.Uri.parse(await client.workbenchUrl())),
      operations: () => showOperations(false),
      call: () => showOperations(true),
      selectWorkspace, registerFolder: changeSharing, accessProfile, doctor, copyMcpUrl, loginCode, configureConnection, menu
    };
    for (const [name,handler] of Object.entries(handlers)) {
      context.subscriptions.push(vscode.commands.registerCommand('devMate.runtime.'+name,async (...args) => {
        try { return await handler(...args); }
        catch (error) { await showError(error); }
      }));
    }
    // Auto-start happens once, when the editor comes up. A workspace that is not trusted yet has no folder to start
    // for; it is started when trust is granted. It never runs on any later occasion: a runtime its user stopped
    // stays stopped, whatever setting or folder changes afterwards.
    let startOnTrust = false;
    const autoStart = async () => {
      if (!settings().get('autoStart', false) || state.running) return;
      if (!folders().roots.length) { startOnTrust = vscode.workspace.isTrusted === false; return; }
      await handlers.start().catch(showError);
    };
    const rebind = () => { boundKey = ''; void refresh().catch(report); };
    const trusted = () => {
      boundKey = '';
      const due = startOnTrust; startOnTrust = false;
      void refresh().then(() => due ? autoStart() : undefined).catch(report);
    };
    if (typeof vscode.workspace.onDidChangeConfiguration === 'function') context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!active || !event.affectsConfiguration('devMate')) return;
      // Where the runtime is and which Node starts it belong to the client: a new one is made for the new values.
      if (!suppliedClient && ['runtimeInstanceDirectory', 'nodeCommandPath', 'runtimePort'].some(key => event.affectsConfiguration('devMate.' + key))) {
        subscription?.dispose(); subscription = null; client?.dispose();
        client = connect(); attachment = null; boundGeneration = '';
      }
      publishedContext = '';
      rebind();
    }));
    if (typeof vscode.workspace.onDidChangeWorkspaceFolders === 'function') context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(rebind));
    if (typeof vscode.workspace.onDidGrantWorkspaceTrust === 'function') context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(trusted));
    for (const [source, event, delay] of [
      [vscode.languages, 'onDidChangeDiagnostics', 600], [vscode.window, 'onDidChangeActiveTextEditor', 150],
      [vscode.window, 'onDidChangeTextEditorSelection', 600], [vscode.workspace, 'onDidOpenTextDocument', 600],
      [vscode.workspace, 'onDidCloseTextDocument', 600], [vscode.workspace, 'onDidSaveTextDocument', 300], [vscode.window, 'onDidChangeWindowState', 150]
    ]) if (typeof source?.[event] === 'function') context.subscriptions.push(source[event](() => scheduleContext(delay)));
    // Another window or the CLI may start, stop or restart the shared runtime at any time.
    poll = setInterval(() => { if (active) void refresh().catch(report); }, POLL_MS);
    poll.unref?.();
    await refresh().catch(report);
    // Opt-in: bring the shared runtime up with the editor so a cloud client can connect without a manual start.
    await autoStart();
    return { attached: state.running, windowId };
  }
  async function deactivate() {
    active = false;
    if (poll) clearInterval(poll);
    if (refreshTimer) clearTimeout(refreshTimer);
    if (contextTimer) clearTimeout(contextTimer);
    subscription?.dispose();
    subscription = null;
    try { if (client && attachment && state.running) await client.call('window.detach',{windowId}); }
    catch (error) { report(error); }
    finally { client?.dispose(); client = null; attachment = null; }
  }
  return {activate,deactivate,refresh,provider,get windowId(){return windowId;},get attachment(){return attachment;},get state(){return state;}};
}

let entry;
function activate(context) {
  entry = createVscodeRuntimeEntry(require('vscode'));
  return entry.activate(context);
}
function deactivate() {
  const existing = entry;
  entry = null;
  return existing?.deactivate();
}

module.exports = {activate,deactivate,createVscodeRuntimeEntry};
