'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const original = Module._load;
Module._load = function (request, ...rest) { return request === 'obsidian' ? { TFile: class {}, getAllTags: () => [] } : original.call(this, request, ...rest); };
const { createObsidianRuntimeEntry } = require('../obsidian-plugin/src/runtime-entry.cjs');
const { createObsidianRuntimeBridge } = require('../obsidian-plugin/src/runtime-host-bridge.cjs');
Module._load = original;

// A runtime as the plugin sees it through its client: projects, attached hosts, editor windows.
function fixture(t, { registered = true, running = true, settings = {}, answers = [] } = {}) {
  const vaultRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-entry-')));
  t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const state = { running, generation: 'generation-1', projects: registered ? [{ id: 'project-1', root: vaultRoot, name: 'Vault' }] : [], hosts: [], windows: new Set(),
    calls: [], contexts: [], notices: [], bridges: [], statusText: '', commands: new Map(), events: {}, subscription: null, disposed: 0, copied: [],
    connection: {}, detachFails: false, workbenchLinks: 0, asked: [] };
  const client = {
    status: async () => state.running ? { running: true, state: 'ready', record: { generation: state.generation }, ...(state.outdated ? { outdated: true } : {}) }
      : { running: false, state: 'stopped', ...(state.crashed ? { crashed: true } : {}) },
    start: async () => { state.running = true; },
    stop: async () => { state.running = false; state.hosts = []; state.windows.clear(); },
    operations: async () => ({ items: [] }),
    // A single-use sign-in link for opening the workbench; never the base of another address.
    workbenchUrl: async () => { state.workbenchLinks++; return 'http://127.0.0.1:8788/?code=single-use'; },
    mcpUrl: async () => 'http://127.0.0.1:8788/mcp',
    subscribe: (listener, onError, onConnected) => { state.subscription = { listener, onConnected }; return { dispose() { state.subscription = null; } }; },
    dispose() { state.disposed++; },
    async call(name, input) {
      state.calls.push(name);
      if (!state.running) throw Object.assign(new Error('DevMate runtime is stopped.'), { code: 'RUNTIME_STOPPED' });
      switch (name) {
        case 'project.list': return { items: state.projects };
        case 'project.create': { const project = { id: 'project-' + (state.projects.length + 1), root: input.root, name: input.name, access: input.access }; state.projects.push(project); return project; }
        case 'project.update': { const project = state.projects.find(item => item.id === input.id); Object.assign(project, { access: input.access }); return project; }
        case 'project.remove': state.projects = state.projects.filter(item => item.id !== input.id); return { id: input.id, removed: true };
        case 'host.list': return { items: state.hosts.filter(host => !input.projectId || host.projectId === input.projectId) };
        case 'host.attach':
          if (!state.projects.some(project => project.id === input.projectId)) throw Object.assign(new Error('project not found'), { code: 'not_found' });
          if (!state.hosts.some(host => host.id === input.hostId)) state.hosts.push({ id: input.hostId, projectId: input.projectId });
          return { id: input.hostId };
        case 'host.detach':
          if (state.detachFails) throw new Error('runtime is busy');
          state.hosts = state.hosts.filter(host => host.id !== input.hostId); return { detached: true };
        case 'window.attach': state.windows.add(input.windowId); return { windowId: input.windowId, title: input.title, roots: input.roots };
        case 'window.heartbeat': if (!state.windows.has(input.windowId)) throw Object.assign(new Error('not attached'), { code: 'window_missing' }); return { attached: true };
        case 'window.context': state.contexts.push(input); return { accepted: true };
        case 'window.detach': return { detached: state.windows.delete(input.windowId) };
        case 'connection.status': return state.connection;
        case 'settings.read': return { active: { auth: state.auth || { mode: 'none' } }, saved: state.saved || { retentionDays: 30 } };
        case 'settings.replace': state.saved = input.config; return { saved: input.config, restartRequired: true };
        case 'auth.code.create': return { code: 'dml_one-time' };
        case 'runtime.doctor': return { version: '4.0.0', status: 'attention', checks: [{ id: 'node', status: 'ok', detail: 'Node 24' }, { id: 'security', status: 'warn', detail: 'No sign-in', fix: 'Require sign-in' }, { id: 'connection', status: 'info', detail: 'Local only', fix: 'Configure a connection' }] };
        default: throw new Error('unexpected operation ' + name);
      }
    }
  };
  const editor = { getCursor: which => which === 'from' ? { line: 3, ch: 2 } : { line: 3, ch: 7 }, getSelection: () => 'hello', lineCount: () => 12 };
  const workspace = {
    getLeavesOfType: () => [], getActiveFile: () => state.activeFile, activeEditor: { editor },
    iterateAllLeaves: visit => { for (const file of state.openFiles) visit({ view: { file } }); },
    on: (name, handler) => { state.events[name] = handler; return { name }; }
  };
  state.activeFile = { path: 'Notes/Active.md', extension: 'md' };
  state.openFiles = [{ path: 'Notes/Active.md' }, { path: 'Other.md' }, { path: 'Notes/Active.md' }];
  const plugin = {
    settings: { autoAttach: true, publishEditorContext: true, ...settings },
    app: { workspace, vault: { adapter: { getBasePath: () => vaultRoot }, getName: () => 'Vault' } },
    registerView() {}, addRibbonIcon() {}, registerEvent() {},
    addCommand: command => state.commands.set(command.id, command.callback),
    addStatusBarItem: () => ({ setText(text) { state.statusText = text; }, setAttribute() {}, addEventListener() {} })
  };
  const bridgeFactory = (_plugin, { projectId }) => {
    const bridge = { hostId: 'host-' + (state.bridges.length + 1), projectId, state: 'new', attaches: 0, disposed: false,
      async start() { await client.call('host.attach', { hostId: bridge.hostId, projectId }); bridge.state = 'attached'; return { hostId: bridge.hostId, projectId, attached: true }; },
      async attach() { bridge.attaches++; if (bridge.attachFails) throw new Error('listener lost'); await client.call('host.attach', { hostId: bridge.hostId, projectId }); return { hostId: bridge.hostId, projectId, attached: true }; },
      async stop() { bridge.state = 'drained'; await client.call('host.detach', { hostId: bridge.hostId }); bridge.state = 'released'; },
      dispose() { bridge.disposed = true; bridge.state = 'released'; } };
    state.bridges.push(bridge); return bridge;
  };
  const entry = createObsidianRuntimeEntry(plugin, { client, bridgeFactory, syncIntervalMs: 3600000, cloudflared: () => state.cloudflared,
    obsidian: { ItemView: class {}, Notice: class { constructor(message) { state.notices.push(message); } } },
    clipboard: { writeText: async value => { state.copied.push(value); } },
    // The person answers with the next prepared answer, or with the first choice.
    ask: async (title, text, choices) => { state.asked.push(title); return answers.length ? answers.shift() : choices[0].value; } });
  t.after(() => entry.deactivate().catch(() => {}));
  return { vaultRoot, state, client, plugin, entry, answers, run: id => state.commands.get('runtime-' + id)() };
}
const f_answer = (fixtureValue, answer) => fixtureValue.answers.push(answer);

test('a registered vault attaches by itself while the runtime runs, and shows it in the status bar', async t => {
  const f = fixture(t);
  await f.entry.activate();
  assert.deepEqual(f.state.hosts, [{ id: 'host-1', projectId: 'project-1' }]);
  assert.equal(f.state.statusText, 'DevMate: vault attached');
  assert.deepEqual(f.entry.status(), { runtime: 'ready', running: true, vault: 'attached', autoAttach: true, hostId: 'host-1', projectId: 'project-1', error: null });
  assert.equal(f.state.calls.includes('project.create'), false);
  // A later sync only confirms the registration.
  await f.entry.sync();
  assert.equal(f.state.bridges.length, 1);
  assert.equal(f.state.bridges[0].attaches, 0);
});

test('a vault that is not a project is never registered automatically', async t => {
  const f = fixture(t, { registered: false });
  await f.entry.activate();
  assert.deepEqual([f.state.hosts.length, f.state.projects.length, f.state.statusText], [0, 0, 'DevMate: vault not shared']);
  await f.run('attach-vault');
  // Attaching shares the vault folder, so it asks first and says what it did.
  assert.deepEqual(f.state.asked, ['Share this vault with DevMate?']);
  assert.deepEqual(f.state.projects.map(project => [project.name, project.root, project.access]), [['Vault', f.vaultRoot, 'write']]);
  assert.match(f.state.notices.at(-1), /shares this vault with connected AI clients \(read and write\)/);
  assert.equal(f.state.statusText, 'DevMate: vault attached');
});

test('how a vault is shared is the owner\'s choice: read only, not now, changed later, or stopped', async t => {
  // Asked to attach, the owner chooses read only.
  const reader = fixture(t, { registered: false, answers: ['read'] });
  await reader.entry.activate();
  await reader.run('attach-vault');
  assert.equal(reader.state.projects[0].access, 'read'); assert.equal(reader.state.statusText, 'DevMate: vault attached (read only)');
  // Later they widen it, then stop sharing altogether: the note tools go and the project is removed.
  reader.state.asked.length = 0;
  f_answer(reader, 'write'); await reader.run('sharing');
  assert.equal(reader.state.projects[0].access, 'write');
  f_answer(reader, 'none'); await reader.run('sharing');
  assert.deepEqual([reader.state.projects.length, reader.state.hosts.length, reader.state.statusText], [0, 0, 'DevMate: vault not shared']);
  assert.match(reader.state.notices.at(-1), /no longer shares this vault/);
  // "Not now" shares nothing and is not asked again by the next sync.
  const declined = fixture(t, { registered: false, answers: [null] });
  await declined.entry.activate();
  await declined.run('attach-vault');
  await declined.entry.sync();
  assert.deepEqual([declined.state.projects.length, declined.state.asked.length], [0, 1]);
});

test('stopping and restarting from Obsidian asks first, and the vault is attached again afterwards', async t => {
  const f = fixture(t, { answers: [false, true, true] });
  await f.entry.activate();
  await f.run('stop');
  assert.equal(f.state.running, true, 'a declined stop stops nothing');
  await f.run('stop');
  assert.deepEqual([f.state.running, f.state.statusText], [false, 'DevMate: stopped']);
  // Stopping is not "detach this vault for good": the next start attaches it again by itself.
  await f.run('start');
  assert.deepEqual([f.state.hosts.length, f.state.statusText, f.entry.status().autoAttach], [1, 'DevMate: vault attached', true]);
  await f.run('restart');
  assert.deepEqual([f.state.running, f.state.hosts.length], [true, 1]);
  assert.deepEqual(f.state.asked, ['Stop the shared DevMate runtime?', 'Stop the shared DevMate runtime?', 'Restart the shared DevMate runtime?']);
  // An explicit Detach does hold.
  await f.run('detach-vault');
  await f.entry.sync();
  assert.deepEqual([f.state.hosts.length, f.entry.status().autoAttach], [0, false]);
});

test('a project of another editor whose folder is gone does not keep the vault from attaching', async t => {
  const f = fixture(t);
  f.state.projects.unshift({ id: 'project-gone', root: path.join(os.tmpdir(), 'devmate-no-such-folder-' + Date.now()), name: 'Deleted' });
  await f.entry.activate();
  assert.equal(f.state.statusText, 'DevMate: vault attached'); assert.equal(f.entry.status().error, null);
});

test('the vault attaches again after a runtime restart, a dropped registration or a drained listener', async t => {
  const f = fixture(t);
  await f.entry.activate();
  // The runtime restarted: its registry is empty, the listener is still ours.
  f.state.hosts = []; f.state.windows.clear(); f.state.generation = 'generation-2';
  f.state.subscription.onConnected({ generation: 'generation-2' });
  await f.entry.sync();
  assert.deepEqual([f.state.bridges.length, f.state.bridges[0].attaches, f.state.hosts.length], [1, 1, 1], 'the same listener was registered again');
  assert.equal(f.state.statusText, 'DevMate: vault attached');
  // The runtime drained and released this host (a project access change): a new listener is needed.
  f.state.hosts = []; f.state.bridges[0].state = 'released';
  await f.entry.sync();
  assert.deepEqual([f.state.bridges.length, f.state.hosts[0].id, f.state.bridges[0].disposed], [2, 'host-2', true]);
  // The registration is gone and the listener cannot be registered again either.
  f.state.hosts = []; f.state.bridges[1].attachFails = true;
  await f.entry.sync();
  assert.deepEqual([f.state.bridges.length, f.state.hosts[0].id, f.state.bridges[1].disposed], [3, 'host-3', true]);
});

test('a stopped runtime is shown, its listener is given up, and a start attaches again', async t => {
  const f = fixture(t);
  await f.entry.activate();
  f.state.running = false; f.state.hosts = [];
  await f.entry.sync();
  assert.deepEqual([f.state.statusText, f.state.bridges[0].disposed, f.entry.status().vault], ['DevMate: stopped', true, 'detached']);
  f.state.crashed = true;
  await f.entry.sync();
  assert.equal(f.state.statusText, 'DevMate: stopped unexpectedly');
  await f.run('start');
  assert.deepEqual([f.state.statusText, f.state.hosts[0].id], ['DevMate: vault attached', 'host-2']);
  f.state.outdated = true;
  await f.entry.sync();
  assert.equal(f.state.statusText, 'DevMate: vault attached · restart the runtime to update');
});

test('an explicit detach holds until the next explicit attach; the setting can switch automatic attach off', async t => {
  const f = fixture(t);
  await f.entry.activate();
  await f.run('detach-vault');
  assert.deepEqual([f.state.hosts.length, f.state.statusText], [0, 'DevMate: vault detached']);
  await f.entry.sync(); await f.entry.sync();
  assert.equal(f.state.hosts.length, 0, 'no automatic attach after an explicit detach');
  await f.run('attach-vault');
  assert.equal(f.state.hosts.length, 1);

  const manual = fixture(t, { settings: { autoAttach: false } });
  await manual.entry.activate();
  assert.deepEqual([manual.state.hosts.length, manual.state.statusText], [0, 'DevMate: vault detached']);
});

test('the active note, selection and open notes are published through the editor-window operations', async t => {
  const f = fixture(t);
  await f.entry.activate();
  assert.equal(f.state.windows.has(f.entry.windowId), true);
  const published = f.state.contexts.at(-1);
  assert.equal(published.windowId, f.entry.windowId);
  assert.deepEqual(published.context.active, { file: path.join(f.vaultRoot, 'Notes', 'Active.md'), languageId: 'markdown', dirty: false, lineCount: 12,
    selection: { startLine: 3, startCharacter: 2, endLine: 3, endCharacter: 7 }, selectedText: 'hello' });
  assert.deepEqual(published.context.open, [{ file: path.join(f.vaultRoot, 'Notes', 'Active.md'), dirty: false }, { file: path.join(f.vaultRoot, 'Other.md'), dirty: false }]);
  assert.deepEqual(published.context.diagnostics, []);
  // Unchanged context is not sent again; a change is, also after the runtime forgot the window.
  const sent = f.state.contexts.length;
  await f.entry.sync();
  assert.equal(f.state.contexts.length, sent);
  assert.equal(f.state.calls.filter(name => name === 'window.heartbeat').length, 1);
  f.state.windows.clear(); f.state.activeFile = { path: 'Other.md', extension: 'md' };
  await f.entry.sync();
  assert.equal(f.state.contexts.at(-1).context.active.file, path.join(f.vaultRoot, 'Other.md'));
  assert.equal(f.state.windows.has(f.entry.windowId), true);
  assert.deepEqual(Object.keys(f.state.events).sort(), ['active-leaf-change', 'editor-change', 'file-open']);

  const quiet = fixture(t, { settings: { publishEditorContext: false } });
  await quiet.entry.activate();
  assert.deepEqual([quiet.state.windows.size, quiet.state.contexts.length, quiet.state.hosts.length], [0, 0, 1]);
});

test('Copy MCP URL and Run doctor use the runtime operations', async t => {
  const f = fixture(t);
  await f.entry.activate();
  await f.run('copy-mcp-url');
  assert.deepEqual(f.state.copied, ['http://127.0.0.1:8788/mcp']);
  assert.equal(f.state.workbenchLinks, 0, 'copying the MCP URL must not spend a workbench sign-in link');
  assert.match(f.state.notices.at(-1), /local MCP URL/);
  f.state.connection = { publicUrl: 'https://devmate.example.com/mcp' };
  await f.run('copy-mcp-url');
  assert.equal(f.state.copied.at(-1), 'https://devmate.example.com/mcp');
  // A quick tunnel that has no address yet copies nothing: the local address is not what a client in the cloud needs.
  f.state.connection = { kind: 'cloudflare-quick', phase: 'connecting' };
  await f.run('copy-mcp-url');
  assert.equal(f.state.copied.length, 2); assert.match(f.state.notices.at(-1), /has not been given its address yet/);
  f.state.connection = { kind: 'cloudflare-quick', phase: 'connected', temporaryAddress: true, remoteMcpVerified: true, publicUrl: 'https://fixture.trycloudflare.com/mcp/key-of-this-start' };
  await f.run('copy-mcp-url');
  assert.equal(f.state.copied.at(-1), 'https://fixture.trycloudflare.com/mcp/key-of-this-start'); assert.match(f.state.notices.at(-1), /ends in the key of this start/);
  const result = await f.entry.doctor();
  assert.equal(result.text, 'DevMate 4.0.0 — attention\n[ok] node: Node 24\n[warn] security: No sign-in\n    -> Require sign-in\n[info] connection: Local only\n    -> Configure a connection');
  // What is merely worth knowing is listed, and not counted as needing attention.
  assert.match(f.state.notices.at(-1), /1 check\(s\) need attention/);
  assert.ok(f.state.commands.has('runtime-doctor') && f.state.commands.has('runtime-copy-mcp-url'));
});

test('against a real runtime: the vault attaches, serves obsidian.*, publishes the active note and recovers a lost registration', { timeout: 60000 }, async t => {
  const { DevMateService } = await import('../runtime/service.mjs');
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-real-')));
  const vaultRoot = path.join(temp, 'vault'); fs.mkdirSync(path.join(vaultRoot, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vaultRoot, 'Notes', 'Active.md'), 'body');
  const service = new DevMateService({ instanceRoot: path.join(temp, 'state'), endpoint: 'http://127.0.0.1:1/api/agent', adapterFactory: () => ({}) });
  const owner = { id: 'owner', role: 'owner', surface: 'local' };
  const project = await service.call('project.create', { root: vaultRoot, name: 'Vault' }, owner);
  const client = { status: async () => ({ running: true, state: 'ready', record: { generation: 'real' } }), call: (name, input) => service.call(name, input, owner),
    operations: async () => ({ items: [] }), workbenchUrl: async () => 'http://127.0.0.1:8788/?code=single-use', mcpUrl: async () => 'http://127.0.0.1:8788/mcp',
    subscribe: () => ({ dispose() {} }), dispose() {} };
  const emitter = { on: () => ({}), offref() {} };
  const plugin = { settings: {}, registerView() {}, addRibbonIcon() {}, addCommand() {}, registerEvent() {}, addStatusBarItem: () => ({ setText() {} }),
    app: { vault: { ...emitter, configDir: '.obsidian', adapter: { getBasePath: () => vaultRoot }, getName: () => 'Vault', getMarkdownFiles: () => [] },
      metadataCache: { ...emitter, getFileCache: () => ({}), resolvedLinks: {}, unresolvedLinks: {} },
      workspace: { getLeavesOfType: () => [], getActiveFile: () => ({ path: 'Notes/Active.md', extension: 'md' }), on: () => ({}),
        activeEditor: { editor: { getCursor: which => ({ line: which === 'from' ? 0 : 0, ch: which === 'from' ? 0 : 4 }), getSelection: () => 'body', lineCount: () => 1 } },
        iterateAllLeaves: visit => visit({ view: { file: { path: 'Notes/Active.md' } } }) } } };
  const entry = createObsidianRuntimeEntry(plugin, { client, syncIntervalMs: 3600000, obsidian: { ItemView: class {}, Notice: class {} } });
  t.after(async () => { await entry.deactivate().catch(() => {}); await service.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

  await entry.activate();
  assert.equal(entry.status().vault, 'attached');
  const vault = (await service.call('capability.list', { projectId: project.id, engine: 'obsidian' }, owner)).engines[0];
  assert.deepEqual([vault.status, vault.capabilities.length, vault.hosts[0].id], ['attached', 16, entry.status().hostId]);
  const status = await service.call('capability.call', { projectId: project.id, capability: 'obsidian.status', input: {} }, owner);
  assert.deepEqual([status.vault, status.protocolVersion, status.host.reachable], ['Vault', 3, true]);
  // The active note reaches the same editor.context operation that serves VS Code windows.
  const editor = await service.call('editor.context', { projectId: project.id }, owner);
  assert.deepEqual([editor.active.path, editor.active.selectedText, editor.active.languageId], ['Notes/Active.md', 'body', 'markdown']);
  assert.match(JSON.stringify(editor.open), /Notes\/Active\.md/);

  // The runtime drops the registration (a forced detach here; a restart looks the same): the next sync restores it.
  const hostId = entry.status().hostId;
  await service.call('host.detach', { hostId, force: true }, owner);
  await assert.rejects(service.call('capability.call', { projectId: project.id, capability: 'obsidian.status', input: {} }, owner), error => error.code === 'host_unavailable');
  await entry.sync();
  assert.equal((await service.call('capability.call', { projectId: project.id, capability: 'obsidian.status', input: {} }, owner)).host.id, hostId, 'the same listener is attached again');
  // Reducing project access drains and releases the host; the plugin then attaches a fresh listener.
  await service.call('project.update', { id: project.id, access: 'read' }, owner);
  assert.deepEqual((await service.call('host.list', {}, owner)).items, []);
  await entry.sync();
  const [again] = (await service.call('host.list', {}, owner)).items;
  assert.ok(again && again.id !== hostId && again.reachable === true);
  await assert.rejects(service.call('capability.call', { projectId: project.id, capability: 'obsidian.note_create', input: { path: 'New.md' } }, owner), error => error.code === 'read_only');
  assert.equal((await service.call('capability.call', { projectId: project.id, capability: 'obsidian.note_query', input: {} }, owner)).total, 0);
});

test('unloading never leaves the vault listener behind, even when the runtime cannot confirm the detach', async t => {
  const f = fixture(t);
  await f.entry.activate();
  f.state.detachFails = true;
  await assert.rejects(f.entry.deactivate(), /runtime is busy/);
  assert.equal(f.state.bridges[0].disposed, true);
  assert.equal(f.state.disposed, 1);
  assert.equal(f.state.windows.size, 0);

  // The real bridge: a failed detach keeps the listener for a retry, dispose closes it for good.
  const vaultRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-bridge-')));
  t.after(() => fs.rmSync(vaultRoot, { recursive: true, force: true }));
  let binding;
  const client = { async call(name, input) { if (name === 'host.attach') { binding = input; return {}; } throw new Error('runtime unreachable'); } };
  const emitter = { on: () => ({}), offref() {} };
  const plugin = { app: { vault: { ...emitter, configDir: '.obsidian', adapter: { getBasePath: () => vaultRoot }, getName: () => 'Vault', getMarkdownFiles: () => [] }, metadataCache: { ...emitter, getFileCache: () => ({}) } } };
  const bridge = createObsidianRuntimeBridge(plugin, { client, projectId: 'project-1' });
  await bridge.start();
  assert.equal(bridge.state, 'attached');
  const ping = () => fetch(binding.url + '/api/call', { method: 'POST', headers: { Authorization: 'Bearer ' + binding.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'host.ping', input: {} }) });
  assert.equal((await (await ping()).json()).result.accepting, true);
  await assert.rejects(bridge.stop(), /runtime unreachable/);
  assert.equal((await (await ping()).json()).result.drained, true, 'still listening for the retry');
  bridge.dispose();
  assert.equal(bridge.state, 'released');
  await assert.rejects(ping(), error => error.cause?.code === 'ECONNREFUSED');
  await bridge.stop();
  await assert.rejects(bridge.start(), /new host bridge/);
});

test('a vault shared after its window was bound is bound again, so the active note reaches the new project at once', async t => {
  // Found in a real Obsidian: start the runtime, then share the vault. The window had been bound while the vault was
  // no project yet, and the runtime never learned which project its notes belong to.
  const f = fixture(t, { registered: false, answers: ['read'] });
  await f.entry.activate();
  const bound = () => f.state.calls.filter(name => name === 'window.attach').length;
  assert.equal(bound(), 1, 'the window is bound while the vault is not shared');
  const sent = f.state.contexts.length;
  await f.run('attach-vault');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(bound(), 2, 'sharing the vault binds the window again');
  assert.ok(f.state.contexts.length > sent, 'and the active note is published again');
  // From then on a check is a heartbeat, not another binding.
  await f.entry.sync();
  assert.equal(bound(), 2);
});

test('with "Start the runtime with Obsidian" on, it is started once when the app comes up, and again only after a crash', async t => {
  const f = fixture(t, { running: false, settings: { autoStart: true } });
  let starts = 0; const start = f.client.start;
  f.client.start = async () => { starts++; return start(); };
  await f.entry.activate();
  assert.equal(starts, 1); assert.equal(f.entry.status().running, true);
  // A runtime its user stopped stays stopped.
  await f.client.stop(); await f.entry.sync();
  assert.equal(starts, 1); assert.equal(f.entry.status().running, false);
  // One that vanished without a clean stop is brought back, a few times at most.
  f.state.crashed = true;
  for (let round = 0; round < 5; round++) { await f.entry.sync(); f.state.running = false; }
  assert.equal(starts, 4);
});

test('without that setting the plugin never starts the runtime by itself', async t => {
  const f = fixture(t, { running: false });
  let starts = 0; f.client.start = async () => { starts++; };
  f.state.crashed = true;
  await f.entry.activate(); await f.entry.sync();
  assert.equal(starts, 0); assert.equal(f.entry.status().running, false);
});
test('the sign-in code is copied when sign-in is on, and the command says where it is switched on when it is off', async t => {
  const f = fixture(t);
  await f.entry.activate();
  assert.equal(await f.run('login-code'), null);
  assert.deepEqual(f.state.copied, []); assert.match(f.state.notices.at(-1), /Sign-in is off/);
  assert.equal(f.state.calls.includes('auth.code.create'), false);
  f.state.auth = { mode: 'oauth', issuer: 'https://devmate.example.test' };
  await f.run('login-code');
  assert.deepEqual(f.state.copied, ['dml_one-time']); assert.match(f.state.notices.at(-1), /Copied a one-time sign-in code/);
});
test('the connection is set up in Obsidian: a quick tunnel needs no account, and other settings are kept', async t => {
  const f = fixture(t, { answers: ['cloudflare-quick'] });
  await f.entry.activate();
  // cloudflared is not on this computer: nothing is saved, and the message says how to get it.
  await f.run('configure-connection');
  assert.equal(f.state.saved, undefined); assert.match(f.state.notices.at(-1), /winget install Cloudflare\.cloudflared/);
  f.state.cloudflared = path.join(os.tmpdir(), 'cloudflared.exe'); f.answers.push('cloudflare-quick');
  const stops = f.state.calls.filter(name => name === 'host.detach').length;
  await f.run('configure-connection');
  assert.deepEqual(f.state.saved, { retentionDays: 30, connection: { kind: 'cloudflare-quick', executable: f.state.cloudflared }, auth: { mode: 'none' } });
  assert.match(f.state.notices.at(-1), /quick tunnel is starting/); assert.equal(f.state.running, true, 'the shared runtime was restarted to apply it');
  assert.ok(f.state.calls.filter(name => name === 'host.detach').length > stops);
  // Choosing what is already set changes nothing; going back to this computer only removes the tunnel.
  f.answers.push('cloudflare-quick');
  assert.equal(await f.run('configure-connection'), null);
  f.answers.push('local');
  await f.run('configure-connection');
  assert.deepEqual(f.state.saved.connection, { kind: 'local' });
});