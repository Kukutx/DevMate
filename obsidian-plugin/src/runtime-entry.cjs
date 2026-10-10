'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const RUNTIME_VIEW_TYPE = 'devmate-runtime';
const SYNC_INTERVAL_MS = 15000;

function createObsidianRuntimeEntry(plugin, { client: suppliedClient, obsidian, bridgeFactory, clipboard, ask: suppliedAsk, syncIntervalMs = SYNC_INTERVAL_MS } = {}) {
  const api = obsidian || require('obsidian');
  const client = suppliedClient || require('../../runtime/host-client.cjs').createHostClient({
    instanceRoot: plugin.settings?.runtimeInstanceDirectory || '',
    nodePath: plugin.settings?.nodeCommandPath || '',
    port: plugin.settings?.runtimePort || 8788
  });
  // One identity for this Obsidian window in the runtime's editor-window registry.
  const windowId = randomUUID();
  const views = new Set();
  let subscription, vaultBridge, attaching, syncing, active = false, timer, contextTimer, statusItem;
  // Attach by itself while the setting allows it; an explicit Detach holds until the next explicit Attach.
  let wanted = plugin.settings?.autoAttach !== false, startConsidered = false;
  const recoveries = [];
  let runtime = { state: 'stopped', running: false }, vault = 'detached', vaultAccess = null, lastError = null, windowBound = false, boundProject = null, publishedContext = '';
  // Projects are stored under their real path. Only the vault's own path is resolved here: another project whose
  // folder has been deleted or is on an unplugged drive must not keep this vault from attaching.
  const key=value=>process.platform==='win32'?value.toLowerCase():value;
  const realKey=value=>{try{return key(fs.realpathSync.native(value));}catch{return key(path.resolve(value));}};
  // One question with a few answers, in Obsidian's own dialog. Resolves to the chosen value, or null when dismissed.
  const ask = suppliedAsk || ((title, text, choices) => {
    if (typeof api.Modal !== 'function') return Promise.resolve(null);
    return new Promise(resolve => {
      const modal = new api.Modal(plugin.app);
      let answer = null;
      modal.onOpen = () => {
        modal.titleEl?.setText?.(title);
        modal.contentEl.createEl('p', { text });
        const row = modal.contentEl.createDiv({ cls: 'modal-button-container' });
        for (const choice of choices) row.createEl('button', { text: choice.label, cls: choice.primary ? 'mod-cta' : choice.warning ? 'mod-warning' : '' })
          .addEventListener('click', () => { answer = choice.value; modal.close(); });
      };
      modal.onClose = () => { modal.contentEl.empty(); resolve(answer); };
      modal.open();
    });
  });
  const vaultRoot = () => {
    const root = plugin.app?.vault?.adapter?.getBasePath?.();
    return root && path.isAbsolute(root) ? root : null;
  };

  function status() {
    return { runtime: runtime.state, running: runtime.running === true, vault, autoAttach: wanted,
      hostId: vaultBridge?.hostId || null, projectId: vaultBridge?.projectId || null, error: lastError };
  }
  function statusText() {
    if (!runtime.running) return 'DevMate: ' + (runtime.crashed ? 'stopped unexpectedly' : runtime.state || 'stopped');
    // A vault that keeps failing to attach is not "attaching": say that it failed; the sidebar has the reason.
    return 'DevMate: ' + ({ attached: 'vault attached' + (vaultAccess === 'read' ? ' (read only)' : ''), unregistered: 'vault not shared',
      detached: wanted ? (lastError ? 'vault could not be attached' : 'vault attaching…') : 'vault detached' })[vault] +
      // This plugin ships a newer runtime than the one that is running.
      (runtime.outdated ? ' · restart the runtime to update' : '');
  }
  function render() {
    statusItem?.setText?.(statusText());
    if (statusItem?.setAttribute) statusItem.setAttribute('aria-label', lastError ? 'DevMate: ' + lastError : 'Open the DevMate sidebar for details');
    for (const view of views) view.showStatus?.();
  }

  async function findProject(root) {
    const rootKey=realKey(root);let project,cursor;
    do { const page=await client.call('project.list',{limit:1000,...(cursor?{cursor}:{})});
      project=page.items.find(item=>key(item.root)===rootKey);cursor=page.nextCursor;
    } while(!project&&cursor);
    return project;
  }
  // create:false is the automatic path: it attaches a vault that is already a project and never registers one.
  async function attachVault({ create = true } = {}) {
    if(attaching)return attaching;
    attaching=(async()=>{
      if(vaultBridge?.state==='attached'){
        const connected=await client.call('host.list',{projectId:vaultBridge.projectId});
        if(connected.items.some(item=>item.id===vaultBridge.hostId))return{hostId:vaultBridge.hostId,projectId:vaultBridge.projectId,attached:true};
        // The runtime restarted or dropped the registration; the listener is still ours.
        try{return await vaultBridge.attach();}catch{}
      }
      if(vaultBridge){vaultBridge.dispose();vaultBridge=null;}
      vault='detached';
      const root=vaultRoot();
      if(!root)throw new Error('A native filesystem vault is required.');
      let project=await findProject(root);
      if(!project){
        if(!create){vault='unregistered';return{attached:false,registered:false};}
        // Attaching a vault shares its folder: connected AI clients work in it with the file tools, not only the note tools.
        const access=await ask('Share this vault with DevMate?','AI clients connected to DevMate will be able to read the notes and files of "'+plugin.app.vault.getName()+'". With write access they can also change them and run commands in the vault folder.',
          [{label:'Read and write',value:'write',primary:true},{label:'Read only',value:'read'},{label:'Not now',value:null}]);
        if(!access){vault='unregistered';wanted=false;return{attached:false,registered:false};}
        project=await client.call('project.create',{name:plugin.app.vault.getName(),root,access});
        new api.Notice('DevMate shares this vault with connected AI clients ('+(access==='read'?'read only':'read and write')+'). Change it with "Change how this vault is shared".');
      }
      vaultAccess=project.access||null;
      const start=bridgeFactory||require('./runtime-host-bridge.cjs').createObsidianRuntimeBridge;
      const bridge=start(plugin,{client,projectId:project.id});
      const result=await bridge.start();vaultBridge=bridge;return result;
    })();
    try{
      const result=await attaching;
      if(result.attached){
        vault='attached';lastError=null;
        // A window that was bound before the vault became a project follows at once, not at the next periodic check.
        if(windowBound&&boundProject!==(vaultBridge?.projectId||null))void bindWindow().then(()=>publishContext()).catch(()=>{});
      }
      return result;
    }finally{attaching=null;render();}
  }
  // explicit: the user asked for it, and it holds until the next explicit Attach. A stop or an unload detaches for now only.
  async function detachVault({ timeoutMs, explicit = true } = {}) {
    if(explicit)wanted=false;
    if(attaching)await attaching.catch(()=>{});
    const bridge=vaultBridge;
    if(bridge){
      try{await bridge.stop(timeoutMs?{timeoutMs}:{});}
      catch(error){
        // A runtime that is gone cannot confirm anything: give the listener up locally.
        const observed=await client.status().catch(()=>({running:false}));
        if(observed.running)throw error;
        bridge.dispose();
      }
      vaultBridge=null;
    }
    vault='detached';render();
  }
  const confirmShared = action => ask(action + ' the shared DevMate runtime?', 'Every editor window, the command line and connected AI clients use this one runtime. ' +
    (action === 'Stop' ? 'Connected clients lose their connection until it is started again.' : 'Clients reconnect after the restart.'),
    [{ label: action, value: true, warning: true }, { label: 'Cancel', value: false }]);
  async function stopRuntime({ confirm = true } = {}) {
    if (confirm && !(await confirmShared('Stop'))) return null;
    await detachVault({ explicit: false }); const result = await client.stop(); await sync(); return result;
  }
  async function restartRuntime() {
    if (!(await confirmShared('Restart'))) return null;
    await detachVault({ explicit: false }); await client.stop(); const result = await client.start(); await sync(); return result;
  }
  // The owner's word on this vault: read and write, read only, or not shared at all.
  async function changeSharing() {
    const root = vaultRoot();
    if (!root) throw new Error('A native filesystem vault is required.');
    const project = await findProject(root);
    if (!project) { wanted = true; return attachVault(); }
    const choice = await ask('How is this vault shared?', 'It is shared ' + (project.access === 'read' ? 'read only' : 'read and write') + ' with AI clients connected to DevMate.',
      [{ label: 'Read and write', value: 'write', primary: project.access !== 'write' }, { label: 'Read only', value: 'read', primary: project.access === 'write' }, { label: 'Stop sharing', value: 'none', warning: true }]);
    if (!choice || choice === project.access) return project;
    if (choice === 'none') {
      await detachVault();
      const removed = await client.call('project.remove', { id: project.id }, { scoped: false });
      vault = 'unregistered'; vaultAccess = null; render();
      new api.Notice('DevMate no longer shares this vault. Its files were not touched.');
      return removed;
    }
    const updated = await client.call('project.update', { id: project.id, access: choice }, { scoped: false });
    vaultAccess = updated.access; render();
    return updated;
  }

  // How much a client connected as the owner may decide: guarded (the default) or full access.
  async function accessProfile() {
    const current = (await client.call('access.read', {}, { scoped: false })).profile;
    const choice = await ask('What may your connected AI client decide?', current === 'full'
      ? 'Full access is on: your client can share folders, read credential files, set up engines and answer agents, and what a delegated agent asks permission for is granted automatically.'
      : 'Guarded (the default): you share folders, lift credential-file protection and answer agents at this computer. Full access hands all of that to your connected client and grants agent permission requests automatically.',
    [{ label: 'Guarded', value: 'guarded', primary: current === 'full' }, { label: 'Full access', value: 'full', warning: current !== 'full' }]);
    if (!choice || choice === current) return current;
    await client.call('access.update', { profile: choice }, { scoped: false });
    new api.Notice(choice === 'full' ? 'DevMate: full access is on. Whoever can reach your MCP address acts as you without asking.' : 'DevMate: back to the guarded profile.');
    return choice;
  }

  // What the user has in front of them: the active note, the selection and the open notes.
  function editorContext() {
    const root = vaultRoot(), workspace = plugin.app?.workspace;
    if (!root || !workspace) return null;
    const absolute = file => path.join(root, ...String(file.path).split('/'));
    const file = workspace.getActiveFile?.();
    let editor = workspace.activeEditor?.editor;
    if (!editor && file) workspace.iterateAllLeaves?.(leaf => { if (!editor && leaf.view?.file?.path === file.path && leaf.view.editor) editor = leaf.view.editor; });
    let activeNote = null;
    if (file) {
      const from = editor?.getCursor?.('from'), to = editor?.getCursor?.('to');
      activeNote = { file: absolute(file), languageId: file.extension === 'md' ? 'markdown' : String(file.extension || ''), dirty: false,
        lineCount: editor?.lineCount?.() || 0,
        selection: { startLine: from?.line || 0, startCharacter: from?.ch || 0, endLine: to?.line || 0, endCharacter: to?.ch || 0 },
        selectedText: String(editor?.getSelection?.() || '').slice(0, 20001) };
    }
    const open = [], seen = new Set();
    workspace.iterateAllLeaves?.(leaf => {
      const item = leaf.view?.file;
      if (item && !seen.has(item.path) && open.length < 200) { seen.add(item.path); open.push({ file: absolute(item), dirty: false }); }
    });
    return { active: activeNote, open, diagnostics: [] };
  }
  // The vault window joins the same editor-window registry VS Code windows use, so editor.context serves both.
  async function bindWindow() {
    const root = vaultRoot();
    if (!root || plugin.settings?.publishEditorContext === false) return;
    // A window bound before the vault became a project is bound again: the runtime decides at binding which project
    // these notes belong to, and does not look again on a heartbeat.
    const projectId = vaultBridge?.projectId || null;
    if (windowBound && projectId === boundProject) {
      try { await client.call('window.heartbeat', { windowId }); return; }
      catch (error) { if (error.code !== 'window_missing') throw error; }
    }
    windowBound = false;
    await client.call('window.attach', { windowId, title: 'Obsidian: ' + plugin.app.vault.getName(), trusted: true,
      roots: [{ root, name: plugin.app.vault.getName() }] });
    windowBound = true; boundProject = projectId; publishedContext = '';
  }
  async function publishContext() {
    if (!active || !runtime.running || !windowBound) return;
    const context = editorContext();
    if (!context) return;
    const fingerprint = JSON.stringify(context);
    if (fingerprint === publishedContext) return;
    await client.call('window.context', { windowId, context });
    publishedContext = fingerprint;
  }
  function scheduleContext(delay = 400) {
    if (!active || contextTimer) return;
    contextTimer = setTimeout(() => { contextTimer = undefined; void publishContext().catch(() => {}); }, delay);
    contextTimer.unref?.();
  }

  // Starting with Obsidian is the owner's setting. It happens once, when the app comes up. After that only a runtime
  // that vanished without a clean stop is started again, a few times at most: one its user stopped stays stopped.
  async function startsItself(state) {
    if (plugin.settings?.autoStart !== true) return false;
    if (startConsidered) {
      if (!state.crashed) return false;
      const moment = Date.now();
      while (recoveries.length && moment - recoveries[0] > 600_000) recoveries.shift();
      if (recoveries.length >= 3) return false;
      recoveries.push(moment);
    }
    startConsidered = true;
    try { await client.start(); return true; }
    catch (error) { lastError = error.message || String(error); return false; }
  }

  // Bring this window in line with the runtime: attach again after a restart, detach state after a stop.
  async function syncOnce() {
    runtime = await client.status();
    if (runtime.running) startConsidered = true;
    else if (await startsItself(runtime)) runtime = await client.status();
    if (!runtime.running) {
      // Nothing can confirm a detach now; a later start gets a fresh listener.
      if (vaultBridge) { vaultBridge.dispose(); vaultBridge = null; }
      vault = 'detached'; windowBound = false;
      return status();
    }
    if (wanted) await attachVault({ create: false }).catch(error => { lastError = error.message || String(error); });
    else if (vault !== 'attached') { const root = vaultRoot(); if (root && !(await findProject(root).catch(() => true))) vault = 'unregistered'; }
    await bindWindow().then(() => publishContext()).catch(() => {});
    return status();
  }
  function sync() {
    if (!syncing) syncing = syncOnce().finally(() => { syncing = null; render(); });
    return syncing;
  }

  async function open() {
    const leaves = plugin.app.workspace.getLeavesOfType(RUNTIME_VIEW_TYPE);
    const leaf = leaves[0] || plugin.app.workspace.getRightLeaf(false) || plugin.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: RUNTIME_VIEW_TYPE, active: true });
    await plugin.app.workspace.revealLeaf(leaf);
  }

  function report(error) {
    lastError = error.message || String(error);
    const portTaken = /Port \d+ on 127\.0\.0\.1 is already used/.test(lastError);
    if (portTaken) lastError += ' Set another one under Settings → DevMate → Local port, then turn this plugin off and on.';
    // What needs a setting changed stays until it is dismissed.
    new api.Notice(lastError, ...(portTaken ? [0] : [])); render();
  }
  // What an earlier action reported is not shown beside the result of the next one.
  const run = action => { lastError = null; return Promise.resolve().then(action).catch(report); };

  async function copyMcpUrl() {
    const connection = await client.call('connection.status', {});
    const value = connection.publicUrl || connection.url || connection.tunnelId || await client.mcpUrl();
    const target = clipboard || globalThis.navigator?.clipboard;
    if (!target) throw new Error('The clipboard is not available here. The address is: ' + value);
    await target.writeText(value);
    new api.Notice(connection.tunnelId ? 'Copied the tunnel ID. In ChatGPT choose the Tunnel connection type.'
      : connection.publicUrl || connection.url ? 'Copied the public MCP URL.' : 'Copied the local MCP URL. Cloud clients need a public connection.');
    return value;
  }
  // The one-time code a client asks for on the authorization page, when sign-in is on.
  async function loginCode() {
    const configured = await client.call('settings.read', {});
    if ((configured.active || configured.saved)?.auth?.mode !== 'oauth') {
      new api.Notice('Sign-in is off for this DevMate, so there is no code to copy. It is switched on with the connection: devmate connect … --auth oauth, or DevMate: Configure Connection in VS Code.');
      return null;
    }
    const issued = await client.call('auth.code.create', {});
    const target = clipboard || globalThis.navigator?.clipboard;
    if (!target) throw new Error('The clipboard is not available here. The code is: ' + issued.code);
    await target.writeText(issued.code);
    new api.Notice('Copied a one-time sign-in code. Paste it on the DevMate authorization page; it expires in 10 minutes.');
    return issued.code;
  }
  async function doctor() {
    const result = await client.call('runtime.doctor', {});
    const lines = ['DevMate ' + result.version + ' — ' + result.status];
    for (const item of result.checks || []) {
      lines.push('[' + item.status + '] ' + item.id + ': ' + item.detail);
      if (item.fix && item.status !== 'ok') lines.push('    -> ' + item.fix);
    }
    const shown = [...views].filter(view => view.resultEl);
    for (const view of shown) view.resultEl.textContent = lines.join('\n');
    const problems = (result.checks || []).filter(item => ['warn', 'fail'].includes(item.status));
    new api.Notice(lines[0] + (problems.length ? ': ' + problems.length + ' check(s) need attention' + (shown.length ? '' : '. Open the DevMate sidebar and run the doctor there for details') : ''));
    return { ...result, text: lines.join('\n') };
  }

  class RuntimeView extends api.ItemView {
    getViewType() { return RUNTIME_VIEW_TYPE; }
    getDisplayText() { return 'DevMate'; }
    getIcon() { return 'bot'; }

    async onOpen() {
      views.add(this);
      this.contentEl.empty();
      this.contentEl.createEl('h2', { text: 'DevMate' });
      this.statusEl = this.contentEl.createEl('p', { text: 'Checking local runtime…' });
      const actions = this.contentEl.createDiv();
      // A button is offered only while it can do something: no Start beside a running runtime.
      this.offered = [];
      const button = (label, action, { when, parent = actions } = {}) => {
        const element = parent.createEl('button', { text: label });
        element.addEventListener('click', () => run(action));
        if (when) this.offered.push([element, when]);
      };
      const running = () => runtime.running === true, attached = () => vault === 'attached';
      button('Start', async () => { await client.start(); await this.refresh(); }, { when: () => !running() });
      button('Stop', async () => { await stopRuntime(); await this.refresh(); }, { when: running });
      button('Restart', async () => { await restartRuntime(); await this.refresh(); }, { when: running });
      button('Vault sharing…', async () => { await changeSharing(); await this.refresh(); }, { when: running });
      button('Attach vault', async () => { wanted = true; await attachVault(); await this.refresh(); }, { when: () => running() && !attached() });
      button('Detach vault', async () => { await detachVault(); await this.refresh(); }, { when: attached });
      button('Refresh', () => this.refresh());
      button('Open workbench', async () => { window.open(await client.workbenchUrl(), '_blank', 'noopener'); }, { when: running });
      button('Copy MCP URL', copyMcpUrl, { when: running });
      button('Doctor', doctor, { when: running });
      button('Permissions…', accessProfile, { when: running });
      // Calling an operation by name is for looking into a problem, not for everyday use.
      const advanced = this.contentEl.createEl('details');
      advanced.createEl('summary', { text: 'Advanced: run an operation' });
      this.operationEl = advanced.createEl('select');
      this.operationEl.setAttribute('aria-label', 'DevMate operation');
      this.inputEl = advanced.createEl('textarea');
      this.inputEl.value = '{}';
      this.inputEl.setAttribute('aria-label', 'Operation JSON input');
      button('Run operation', async () => {
        let input;
        try { input = JSON.parse(this.inputEl.value); } catch { throw new Error('The input is not valid JSON.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Input must be a JSON object');
        const result = await client.call(this.operationEl.value, input);
        this.resultEl.textContent = JSON.stringify(result, null, 2);
        await this.refresh();
      }, { when: running, parent: advanced });
      this.resultEl = this.contentEl.createEl('pre');
      await this.refresh().catch(report);
    }

    showStatus() {
      if (this.statusEl) this.statusEl.textContent = statusText() + (lastError ? ' — ' + lastError : '');
      for (const [element, when] of this.offered || []) element.disabled = !when();
    }

    async refresh() {
      await sync();
      this.showStatus();
      if (!runtime.running) {
        this.operationEl.empty();
        return;
      }
      const catalog = await client.operations();
      const operations = catalog.items;
      const selected = this.operationEl.value;
      this.operationEl.empty();
      for (const operation of operations) {
        const option = this.operationEl.createEl('option', { text: operation.name, value: operation.name });
        option.title = operation.description || '';
      }
      if (operations.some(operation => operation.name === selected)) this.operationEl.value = selected;
    }

    async onClose() { views.delete(this); }
  }

  async function activate() {
    active = true;
    plugin.registerView(RUNTIME_VIEW_TYPE, leaf => new RuntimeView(leaf));
    plugin.addRibbonIcon('bot', 'Open DevMate', () => open().catch(report));
    statusItem = plugin.addStatusBarItem?.() || null;
    statusItem?.addEventListener?.('click', () => open().catch(report));
    statusItem?.addClass?.('mod-clickable');
    const command = (id, name, action) => plugin.addCommand({
      id: `runtime-${id}`, name,
      callback: () => run(action)
    });
    command('open', 'Open sidebar', open);
    command('start', 'Start runtime', async () => { await client.start(); await sync(); });
    command('stop', 'Stop shared runtime', stopRuntime);
    command('restart', 'Restart shared runtime', restartRuntime);
    command('sharing', 'Change how this vault is shared', changeSharing);
    command('attach-vault', 'Attach this vault (share it and offer the note tools)', () => { wanted = true; return attachVault(); });
    command('detach-vault', 'Detach this vault (stop the note tools; sharing is unchanged)', detachVault);
    command('status', 'Show status', async () => { await sync(); new api.Notice(statusText()); });
    command('workbench', 'Open workbench', async () => window.open(await client.workbenchUrl(), '_blank', 'noopener'));
    command('copy-mcp-url', 'Copy MCP URL', copyMcpUrl);
    command('login-code', 'Copy one-time sign-in code', loginCode);
    command('doctor', 'Doctor', doctor);
    command('access-profile', 'Change permission profile (guarded or full access)', accessProfile);
    const workspace = plugin.app?.workspace;
    if (workspace?.on && plugin.registerEvent) {
      for (const [event, delay] of [['active-leaf-change', 150], ['file-open', 150], ['editor-change', 600]]) plugin.registerEvent(workspace.on(event, () => scheduleContext(delay)));
    }
    if (plugin.registerDomEvent && typeof document !== 'undefined') plugin.registerDomEvent(document, 'selectionchange', () => scheduleContext(600));
    if (plugin.registerDomEvent && typeof window !== 'undefined') plugin.registerDomEvent(window, 'beforeunload', () => { if (windowBound) void client.call('window.detach', { windowId }).catch(() => {}); });
    // A reconnected event stream is the earliest sign of a restarted runtime; the interval covers everything else.
    const announced = new Set();
    subscription = client.subscribe(event => {
      const data = event?.data, entity = data?.entity;
      // An agent that waits for a decision is waiting for the person; in this vault's project that person is here.
      if (['approval.created', 'input.created'].includes(data?.type) && entity?.status === 'pending' && data.projectId === vaultBridge?.projectId && !announced.has(entity.id)) {
        announced.add(entity.id);
        new api.Notice((data.type === 'approval.created' ? 'An agent is waiting for your approval' : 'An agent is asking you a question') +
          (typeof entity.summary === 'string' ? ': ' + entity.summary.slice(0, 200) : '') + '. Open the DevMate workbench to answer.');
      }
      for (const view of views) view.showStatus?.();
    }, () => {}, () => { void sync().catch(() => {}); });
    timer = setInterval(() => { if (active) void sync().catch(() => {}); }, syncIntervalMs);
    timer.unref?.();
    // The note index reads Obsidian's metadata cache, which is filled while the app starts: wait for the layout.
    const first = () => sync().catch(error => { lastError = error.message || String(error); });
    if (typeof workspace?.onLayoutReady === 'function') workspace.onLayoutReady(() => { if (active) void first(); });
    else await first();
    return { activated: true };
  }

  async function deactivate() {
    active = false;
    if (timer) clearInterval(timer);
    if (contextTimer) clearTimeout(contextTimer);
    subscription?.dispose();
    subscription = null;
    try {
      if (windowBound) await client.call('window.detach', { windowId }).catch(() => {});
      // An unload must not hang on a busy runtime, and must never leave the listener behind.
      await detachVault({ timeoutMs: 10000, explicit: false });
    } finally {
      vaultBridge?.dispose(); vaultBridge = null;
      client.dispose();
    }
    // The sidebar leaf is Obsidian's to restore or close: a reloaded plugin would otherwise lose the one it just opened.
    views.clear();
  }

  return { activate, deactivate, open, attachVault, detachVault, changeSharing, accessProfile, stopRuntime, restartRuntime, sync, status, copyMcpUrl, loginCode, doctor, editorContext, RuntimeView, windowId };
}

module.exports = { createObsidianRuntimeEntry, RUNTIME_VIEW_TYPE };
