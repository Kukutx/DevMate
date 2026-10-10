import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createCapabilities } from '../runtime/capabilities.mjs';
import { godotAutomationConfigSchema } from '../runtime/engines/godot.mjs';
import { advancedAutomationConfigSchema } from '../runtime/engines/godot-advanced-automation.mjs';

const owner = Object.freeze({ callerRole: 'owner', ownerDecides: true }), writer = Object.freeze({ callerRole: 'write' }), reader = Object.freeze({ callerRole: 'read' });
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-capability-catalog-'));
// A real native executable that answers --version and matches the Godot executable pattern.
const godot = path.join(shared, process.platform === 'win32' ? 'godot.exe' : 'godot');
fs.copyFileSync(process.execPath, godot);
fs.chmodSync(godot, 0o755);
test.after(() => fs.rmSync(shared, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function fixture(t, { access = 'write' } = {}) {
  const root = fs.mkdtempSync(path.join(shared, 'case-'));
  const project = { id: 'one', name: 'Catalog project', root: path.join(root, 'project'), access };
  fs.mkdirSync(project.root);
  fs.writeFileSync(path.join(project.root, 'project.godot'), 'config_version=5\n[application]\nconfig/name="Fixture"\nrun/main_scene="res://main.tscn"\n');
  fs.writeFileSync(path.join(project.root, 'main.tscn'), '[gd_scene format=3]\n[node name="Main" type="Node2D"]\n');
  const settings = new Map(), events = [];
  const service = {
    project(id, { write = false } = {}) {
      assert.equal(id, 'one');
      if (write && project.access !== 'write') throw Object.assign(new Error('Project is read-only.'), { code: 'read_only' });
      return project;
    },
    store: { setting(key, value) { if (value !== undefined) settings.set(key, value); return settings.get(key); }, event(...args) { events.push(args); } }
  };
  const open = async options => { const cap = await createCapabilities({ service, instanceRoot: path.join(root, 'instance'), ...options }); t.after(() => cap.close()); return cap; };
  const call = (cap, capability, input = {}, role = owner) => cap.call({ projectId: 'one', capability, input }, role);
  return { root, project, service, settings, events, open, call };
}
const names = listing => listing.engines.flatMap(engine => engine.capabilities.map(item => item.name));
const find = (listing, name) => listing.engines.flatMap(engine => engine.capabilities).find(item => item.name === name);

test('the unfiltered listing is a compact summary grouped by engine, never a dump of schemas', async t => {
  const f = fixture(t), cap = await f.open();
  const listing = await cap.list({ projectId: 'one' }, owner);
  assert.deepEqual(listing.engines.map(engine => engine.id), ['automation', 'browser-control', 'browser-qa', 'godot', 'reverse']);
  assert.ok(listing.engines.every(engine => engine.status === 'ready' && engine.name && engine.capabilities.length > 0));
  const text = JSON.stringify(listing);
  assert.equal(text.includes('inputSchema'), false);
  assert.ok(Buffer.byteLength(text) < 24000, 'summary is ' + Buffer.byteLength(text) + ' bytes');
  assert.ok(names(listing).length > 80);
  assert.ok(listing.engines.flatMap(engine => engine.capabilities).every(item => item.description.length <= 160 && !item.description.includes('\n')));
  assert.match(listing.hint, /capability_list \{name\}/);
  assert.match(listing.hint, /operations_call \{operation:"job\.start", input:\{kind:"capability"/);
  // Flags appear only when true.
  assert.deepEqual(Object.keys(find(listing, 'godot.status')), ['name', 'description', 'readOnly']);
  assert.equal(find(listing, 'godot.export').longRunning, true);
  assert.equal(find(listing, 'godot.export').readOnly, undefined);
  assert.equal(find(listing, 'browser-control.start').ownerOnly, true);
  assert.equal(find(listing, 'reverse.memory_read').ownerOnly, true);
  assert.equal(find(listing, 'godot.automation_bootstrap').dryRun, true);
  assert.equal(listing.engines.find(engine => engine.id === 'godot').diagnose, 'godot.diagnose');
  for (const name of ['process.list', 'process.read', 'process.stop']) assert.equal(names(listing).includes(name), false, name + ' is a top-level operation, not a capability');
});

test('engine, name and summary filters select how much is returned', async t => {
  const f = fixture(t), cap = await f.open();
  const godotOnly = await cap.list({ projectId: 'one', engine: 'godot' }, owner);
  assert.deepEqual(godotOnly.engines.map(engine => engine.id), ['godot']);
  assert.ok(godotOnly.engines[0].capabilities.every(item => item.inputSchema?.type === 'object' && typeof item.readOnly === 'boolean' && typeof item.ownerOnly === 'boolean' && typeof item.longRunning === 'boolean'));
  const brief = await cap.list({ projectId: 'one', engine: 'godot', summary: true }, owner);
  assert.equal(JSON.stringify(brief).includes('inputSchema'), false);
  assert.deepEqual(names(brief), names(godotOnly));

  const one = await cap.list({ projectId: 'one', name: 'godot.export' }, owner);
  assert.equal(one.capability.name, 'godot.export');
  assert.equal(one.capability.engine, 'godot');
  assert.deepEqual([one.capability.readOnly, one.capability.ownerOnly, one.capability.longRunning], [false, false, true]);
  assert.ok(one.capability.inputSchema.properties.preset);
  assert.equal(one.capability.inputSchema.properties.workspaceId, undefined);
  assert.match(one.hint, /operations_call \{operation:"job\.start", input:\{kind:"capability", input:\{capability:"godot\.export", input\}\}\} and follow it with operations_query \{operation:"job\.read"/);
  assert.equal(one.engines, undefined);

  await assert.rejects(cap.list({ projectId: 'one', engine: 'devmate.godot' }, owner), error => error.code === 'unknown_engine' && /godot, reverse/.test(error.message));
  await assert.rejects(cap.list({ projectId: 'one', name: 'godot_export' }, owner), error => error.code === 'unknown_capability' && /Did you mean godot\.export\?/.test(error.message));
  await assert.rejects(f.call(cap, 'browser_control_start'), error => error.code === 'unknown_capability' && /browser-control\.start/.test(error.message));
});

test('owner-only tools are refused and hidden for members; readers see only what they may call', async t => {
  const f = fixture(t), cap = await f.open({ engineSettings: { reverse: { allowProcessAccess: true } } });
  fs.writeFileSync(path.join(f.project.root, 'sample.bin'), Buffer.from('plain text sample'));
  for (const role of [writer, reader]) {
    for (const [capability, input] of [
      ['reverse.processes', {}], ['reverse.session_open', { pid: 4321 }], ['reverse.code_analyze', { path: 'sample.bin', query: 'functions' }],
      ['reverse.decompile', { path: 'sample.bin', address: '0x1000' }], ['reverse.disassemble', { hex: '90', architecture: 'x86_64' }],
      ['godot.quick_setup', { executablePath: godot }], ['browser-control.start', { profileMode: 'workspace' }]
    ]) {
      await assert.rejects(f.call(cap, capability, input, role), error => error.code === 'forbidden' && /only to the owner/.test(error.message), role.callerRole + ' ' + capability);
    }
  }
  assert.equal(f.settings.size, 0, 'a refused quick_setup stored nothing');
  // Built-in file inspection reaches nothing a member cannot already read.
  assert.equal((await f.call(cap, 'reverse.strings', { path: 'sample.bin' }, reader)).structuredContent.path, 'sample.bin');

  const forWriter = await cap.list({ projectId: 'one' }, writer), forReader = await cap.list({ projectId: 'one' }, reader), forOwner = await cap.list({ projectId: 'one' }, owner);
  assert.ok(names(forOwner).includes('reverse.processes'));
  for (const name of ['reverse.processes', 'reverse.code_analyze', 'godot.quick_setup', 'browser-control.start', 'browser-control.snapshot']) {
    assert.equal(names(forWriter).includes(name), false, 'writer sees ' + name);
  }
  assert.deepEqual(forWriter.engines.find(engine => engine.id === 'browser-control').capabilities, []);
  assert.ok(names(forWriter).includes('godot.export'));
  assert.equal(names(forReader).includes('godot.export'), false);
  assert.ok(names(forReader).includes('godot.status'));
  assert.ok(names(forReader).includes('godot.automation_bootstrap'), 'a dry-run capable tool stays visible to readers');
  await assert.rejects(cap.list({ projectId: 'one', name: 'godot.export' }, reader), error => error.code === 'forbidden' && /write access/.test(error.message));
});

test('read-only tools and dry runs work without write access', async t => {
  const f = fixture(t, { access: 'read' }), cap = await f.open({ engineSettings: { godot: { executablePath: godot } } });
  // The project is read-only: a version probe needs no write access, for any role.
  for (const role of [owner, reader]) {
    const runtime = (await f.call(cap, 'godot.runtime_status', {}, role)).structuredContent;
    assert.equal(runtime.versionResult.exitCode, 0);
    assert.equal(runtime.version.valid, true);
    assert.equal(runtime.executableName, path.basename(godot));
  }
  const doctor = (await f.call(cap, 'godot.doctor', {}, reader)).structuredContent;
  assert.equal(doctor.version.exitCode, 0);
  assert.equal((await cap.list({ projectId: 'one', name: 'godot.doctor' }, reader)).capability.readOnly, true);

  const dry = (await f.call(cap, 'godot.automation_bootstrap', { dryRun: true }, reader)).structuredContent;
  assert.equal(dry.dryRun, true);
  assert.equal(dry.manifest.schemaVersion, 1);
  assert.equal(fs.existsSync(path.join(f.project.root, '.devmate')), false);
  await assert.rejects(f.call(cap, 'godot.automation_bootstrap', {}, reader), error => error.code === 'forbidden' && /dry run/.test(error.message));
  await assert.rejects(f.call(cap, 'godot.automation_bootstrap', {}, owner), /read-only/i);

  // A Mach-O magic number: a recognized executable kind, so auto mode would choose an installed parser.
  const bytes = Buffer.concat([Buffer.from('feedfacf', 'hex'), Buffer.alloc(252)]);
  fs.writeFileSync(path.join(f.project.root, 'tool.exe'), bytes);
  // Auto mode gives a non-owner the built-in parser instead of refusing.
  const info = (await f.call(cap, 'reverse.binary_info', { path: 'tool.exe' }, reader)).structuredContent;
  assert.equal(info.backend.engine, 'builtin');
  assert.equal(info.backend.fallback, true);
  assert.match(info.backend.reason, /owner/);
  await assert.rejects(f.call(cap, 'reverse.binary_info', { path: 'tool.exe', engine: 'lief' }, reader), /only to the owner/);
  const status = (await f.call(cap, 'reverse.status', { probe: true }, reader)).structuredContent;
  assert.match(status.toolchain.probeError, /owner/);
  assert.equal(status.nativeProbe, undefined);

  const { createHash } = await import('node:crypto');
  const patch = { path: 'tool.exe', expectedSha256: createHash('sha256').update(bytes).digest('hex'), patches: [{ offset: 8, expectedHex: '00', replacementHex: '01' }] };
  const planned = (await f.call(cap, 'reverse.patch_copy', patch, reader)).structuredContent;
  assert.equal(planned.dryRun, true);
  await assert.rejects(f.call(cap, 'reverse.patch_copy', { ...patch, dryRun: false, confirm: true, outputPath: 'patched.exe' }, reader), error => error.code === 'forbidden');
  assert.equal(fs.existsSync(path.join(f.project.root, 'patched.exe')), false);
});

test('engineSettings are validated when the runtime starts, naming the engine and the key', async t => {
  const f = fixture(t);
  await assert.rejects(f.open({ engineSettings: { godot: { bogus: 1 } } }),
    error => error.code === 'invalid_settings' && /godot engine \(engineSettings\.godot\)/.test(error.message) && /bogus/.test(error.message) && /executablePath/.test(error.message));
  await assert.rejects(f.open({ engineSettings: { 'devmate.godot': { executablePath: '' } } }),
    error => error.code === 'invalid_settings' && /unknown engine "devmate\.godot"/.test(error.message) && /Engine ids are: .*godot/.test(error.message));
  await assert.rejects(f.open({ engineSettings: { reverse: { nativeTimeoutMs: 1 } } }), error => error.code === 'invalid_settings' && /reverse engine/.test(error.message) && /nativeTimeoutMs/.test(error.message));
  await assert.rejects(f.open({ engineSettings: { godot: { enabled: 'no' } } }), error => error.code === 'invalid_settings' && /enabled must be true or false/.test(error.message));
  await assert.rejects(f.open({ engineSettings: { obsidian: { vault: 'x' } } }), error => error.code === 'invalid_settings' && /only setting is enabled/.test(error.message));
  const cap = await f.open({ engineSettings: { godot: { defaultWebPreset: 'HTML5' }, obsidian: { enabled: true } } });
  assert.equal((await f.call(cap, 'godot.status')).structuredContent.settings.defaultWebPreset, 'HTML5');
});

test('capability.configure and capability.settings: owner-only writes, layered values, clear errors', async t => {
  const f = fixture(t), cap = await f.open({ engineSettings: { godot: { defaultWebPreset: 'FromConfig' } } });
  await assert.rejects(cap.configure({ engine: 'godot', settings: { executablePath: godot } }, writer), error => error.code === 'forbidden');
  await assert.rejects(cap.configure({ engine: 'devmate.godot', settings: {} }, owner), error => error.code === 'unknown_engine');
  await assert.rejects(cap.configure({ engine: 'godot', settings: { executable: godot } }, owner),
    error => error.code === 'invalid_settings' && /godot engine \(capability\.configure\)/.test(error.message) && /executable/.test(error.message));
  await assert.rejects(cap.configure({ engine: 'godot', settings: 'executablePath' }, owner), error => error.code === 'invalid_input');
  assert.equal(f.settings.size, 0, 'a rejected change stores nothing');

  const configured = await cap.configure({ engine: 'godot', settings: { executablePath: godot } }, owner);
  assert.equal(configured.scope, 'instance');
  assert.equal(configured.settings.executablePath, godot);
  assert.equal(configured.settings.defaultWebPreset, 'FromConfig');
  assert.deepEqual(f.settings.get('engine-settings.godot'), { executablePath: godot });
  assert.equal((await f.call(cap, 'godot.status')).structuredContent.executable, fs.realpathSync.native(godot));

  // A project value overrides the instance value; quick_setup stores only what it sets.
  await f.call(cap, 'godot.quick_setup', { defaultWebPreset: 'ProjectPreset' });
  assert.deepEqual(f.settings.get('capability.one.godot'), { defaultProjectSubpath: '.', defaultWebPreset: 'ProjectPreset' });
  const forProject = (await cap.settings({ engine: 'godot', projectId: 'one' }, owner)).items[0];
  assert.equal(forProject.settings.defaultWebPreset, 'ProjectPreset');
  assert.equal(forProject.settings.executablePath, godot, 'the instance value still applies');
  assert.deepEqual(forProject.stored.config, { defaultWebPreset: 'FromConfig' });
  assert.ok(forProject.schema.properties.executablePath);

  // null restores a default.
  assert.equal((await cap.configure({ engine: 'godot', settings: { executablePath: null } }, owner)).settings.executablePath, '');
  assert.deepEqual(f.settings.get('engine-settings.godot'), {});

  const all = await cap.settings({}, owner);
  assert.deepEqual(all.items.map(item => item.engine), ['automation', 'browser-control', 'browser-qa', 'godot', 'reverse', 'obsidian']);
  // Values name local programs and folders: other callers get the key names only.
  const member = (await cap.settings({ engine: 'reverse' }, reader)).items[0];
  assert.equal(member.settings, undefined);
  assert.equal(member.stored, undefined);
  assert.ok(member.keys.includes('pythonPath') && member.keys.includes('enabled'));
  await assert.rejects(cap.settings({ engine: 'nope' }, owner), error => error.code === 'unknown_engine');
});

test('an engine can be switched off and on again; switching off closes what it had open', async t => {
  const f = fixture(t);
  let activations = 0, deactivations = 0;
  const engine = { manifest: { id: 'devmate.toggle', name: 'Toggle', permissions: {} }, defaultSettings: {},
    activate(context) { const generation = ++activations; context.server.registerTool('generation', { inputSchema: {}, annotations: { readOnlyHint: true } }, () => ({ generation })); },
    deactivate() { deactivations++; } };
  const other = { manifest: { id: 'devmate.other', name: 'Other', permissions: {} }, activate(context) { context.server.registerTool('ping', { inputSchema: {}, annotations: { readOnlyHint: true } }, () => ({ pong: true })); } };
  const cap = await f.open({ engines: [engine, other] });
  assert.deepEqual(await f.call(cap, 'toggle.generation'), { generation: 1 });

  const off = await cap.configure({ engine: 'toggle', settings: { enabled: false } }, owner);
  assert.equal(off.enabled, false);
  assert.equal(deactivations, 1, 'its resources were closed at once');
  await assert.rejects(f.call(cap, 'toggle.generation'), error => error.code === 'capability_disabled' && /capability\.configure \{engine:"toggle", settings:\{enabled:true\}\}/.test(error.message));
  const listing = await cap.list({ projectId: 'one' }, owner);
  assert.deepEqual(listing.engines.find(item => item.id === 'toggle'), { id: 'toggle', name: 'Toggle', status: 'disabled', capabilities: [] });
  assert.deepEqual(await f.call(cap, 'other.ping'), { pong: true });

  await cap.configure({ engine: 'toggle', settings: { enabled: true } }, owner);
  assert.deepEqual(await f.call(cap, 'toggle.generation'), { generation: 2 }, 'a fresh engine context');
  // Off for one project only.
  await cap.configure({ engine: 'toggle', projectId: 'one', settings: { enabled: false } }, owner);
  await assert.rejects(f.call(cap, 'toggle.generation'), error => error.code === 'capability_disabled');
  assert.equal((await cap.settings({ engine: 'toggle' }, owner)).items[0].enabled, true);
  assert.equal((await cap.settings({ engine: 'toggle', projectId: 'one' }, owner)).items[0].enabled, false);
});

test('an engine that cannot activate is reported as unavailable while the others work', async t => {
  const f = fixture(t);
  let cleaned = 0;
  const broken = { manifest: { id: 'devmate.broken', name: 'Broken', permissions: {} },
    activate(context) { context.server.registerTool('early', { inputSchema: {}, annotations: { readOnlyHint: true } }, () => ({})); context.services.provide('devmate.broken', {}); throw new Error('native module missing'); },
    deactivate() { cleaned++; } };
  const healthy = { manifest: { id: 'devmate.healthy', name: 'Healthy', permissions: {} },
    activate(context) { context.server.registerTool('ping', { inputSchema: {}, annotations: { readOnlyHint: true } }, () => ({ pong: true })); },
    diagnose: async context => ({ caller: context.caller() }) };
  const cap = await f.open({ engines: [broken, healthy] });
  const listing = await cap.list({ projectId: 'one' }, owner);
  assert.deepEqual(listing.engines.find(engine => engine.id === 'broken'), { id: 'broken', name: 'Broken', status: 'unavailable', error: 'native module missing', capabilities: [] });
  assert.equal(cleaned, 1);
  assert.deepEqual(await f.call(cap, 'healthy.ping'), { pong: true });
  await assert.rejects(f.call(cap, 'broken.early'), error => error.code === 'capability_unavailable' && /native module missing/.test(error.message));
  // The engine diagnose function is a real capability.
  assert.equal(listing.engines.find(engine => engine.id === 'healthy').diagnose, 'healthy.diagnose');
  const diagnosed = (await f.call(cap, 'healthy.diagnose', {}, reader)).structuredContent;
  assert.deepEqual(diagnosed, { engine: 'healthy', status: 'ready', diagnostics: { caller: 'read' } });
  assert.deepEqual((await f.call(cap, 'healthy.diagnose')).structuredContent.settings, {});
});

test('errors carry a code and readable text instead of raw schema or DOM errors', async t => {
  const f = fixture(t);
  const engine = { manifest: { id: 'devmate.errors', name: 'Errors', permissions: {} }, activate(context) {
    const tool = (name, run, inputSchema = {}) => context.server.registerTool(name, { inputSchema, annotations: { readOnlyHint: true } }, run);
    tool('typed', () => ({}), { count: z.number().int().min(1), mode: z.enum(['a', 'b']).optional() });
    tool('data', () => z.object({ version: z.literal(1) }).parse({ version: 2 }));
    tool('slow', () => { throw new DOMException('The operation timed out', 'TimeoutError'); });
    tool('missing', () => context.workspace.resolve(context.workspace.get(), 'no/such/file.bin', { mustExist: true }));
  } };
  const cap = await f.open({ engines: [engine] });
  await assert.rejects(f.call(cap, 'errors.typed', { count: 0, extra: true }),
    error => error.code === 'invalid_input' && /Invalid input for errors\.typed: /.test(error.message) && /count: /.test(error.message) && /extra/.test(error.message) && !error.message.includes('[\n'));
  await assert.rejects(f.call(cap, 'errors.data'), error => error.code === 'invalid_data' && /version: /.test(error.message) && error.notStarted === undefined);
  // What is refused before the capability runs is marked, so a job reports "not started" instead of an unknown outcome.
  for (const [capability, input, role] of [['errors.typed', {}, owner], ['errors.absent', {}, owner], ['godot.export', {}, reader]]) {
    await assert.rejects(f.call(cap, capability, input, role), error => error.notStarted === true, capability);
  }
  await assert.rejects(f.call(cap, 'errors.slow'), error => error.code === 'timeout' && typeof error.code === 'string');
  await assert.rejects(f.call(cap, 'errors.missing'), error => error.code === 'not_found' && /no\/such\/file\.bin/.test(error.message));
  await assert.rejects(cap.call({ projectId: 'one', capability: '', input: {} }, owner), error => error.code === 'invalid_input');
});

test('the automation engine serves a template every reader accepts and reports manifest status', async t => {
  const f = fixture(t), cap = await f.open();
  const before = (await f.call(cap, 'automation.manifest_status', {}, reader)).structuredContent;
  assert.deepEqual([before.exists, before.manifestPath, before.schemaVersion, before.sections], [false, '.devmate/automation.json', null, []]);
  const template = (await f.call(cap, 'automation.manifest_template', {}, reader)).structuredContent;
  assert.equal(template.path, '.devmate/automation.json');
  godotAutomationConfigSchema.parse(template.manifest.plugins['devmate.godot']);
  advancedAutomationConfigSchema.parse(template.manifest.plugins['devmate.godot-advanced']);
  fs.mkdirSync(path.join(f.project.root, '.devmate'));
  fs.writeFileSync(path.join(f.project.root, '.devmate', 'automation.json'), JSON.stringify(template.manifest));
  const after = (await f.call(cap, 'automation.manifest_status', {}, reader)).structuredContent;
  assert.equal(after.exists, true);
  assert.equal(after.schemaVersion, 1);
  assert.deepEqual(after.validateWith, { 'devmate.browser-qa': 'browser-qa.manifest', 'devmate.godot': 'godot.automation_manifest', 'devmate.godot-advanced': 'godot.advanced_manifest' });
  // Each named reader accepts the saved template through the real path policy.
  assert.equal((await f.call(cap, 'godot.automation_manifest', {}, reader)).structuredContent.config.scenarios[0].id, 'native-smoke');
  assert.equal((await f.call(cap, 'godot.advanced_manifest', {}, reader)).structuredContent.config.scenarios[0].kind, 'performance');
  assert.deepEqual((await f.call(cap, 'browser-qa.manifest', {}, reader)).structuredContent.scenarios, []);
});
