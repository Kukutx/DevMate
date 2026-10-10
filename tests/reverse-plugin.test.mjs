import { createEngineState } from '../runtime/engine-state.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { reversePlugin, reverseSettingsSchema } from '../runtime/engines/reverse.mjs';
import { resolveWorkspacePath } from '../runtime/engines/engine-io.mjs';
import { createCapabilities } from '../runtime/capabilities.mjs';
import { sha256 } from '../runtime/engines/reverse-files.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-plugin-'));
const root = path.join(temp, 'workspace');
await fsp.mkdir(root);
const ws = { id: 'reverse-test', root, name: 'Reverse test' };
let settings = reverseSettingsSchema.parse({}), profile = 'fullAccess';
const tools = new Map(), audit = [];
const context = {
  state: createEngineState('devmate.reverse'), assertActive() {},
  get settings() { return settings; },
  server: { registerTool(name, config, handler) { tools.set(name, { config, handler }); } },
  toolText: value => value,
  // fullAccess: the owner on a writable project. readOnly: a read-only project. balanced: a write member.
  caller: () => profile === 'balanced' ? 'write' : 'owner',
  assertOwner(action) { if (this.caller() !== 'owner') throw new Error(action + ' is available only to the owner'); },
  assertCanMutate() { if (profile === 'readOnly') throw new Error('Read-only profile'); },
  workspace: {
    get(id, { writable = false } = {}) { if (id && id !== ws.id) throw new Error('Unknown workspace'); if (writable && profile === 'readOnly') throw new Error('Read-only workspace'); return ws; },
    resolve: resolveWorkspacePath
  },
  audit: async (action, payload) => { audit.push({ action, payload }); },
  executables: { find: () => null, assertAllowed: () => {} }
};
reversePlugin.activate(context);
const call = (name, args = {}) => tools.get(name).handler(args);

test('all 29 Reverse tools retain serializable schemas and explicit read/write annotations', () => {
  assert.equal(tools.size, 29);
  for (const [name, entry] of tools) {
    assert.equal(typeof entry.config.annotations.readOnlyHint, 'boolean', name);
    assert.doesNotThrow(() => z.toJSONSchema(z.object(entry.config.inputSchema)), name);
  }
});

test('new capability composition scopes Reverse and refuses read-role writes', async t => {
  const project = { ...ws, access: 'write' }, saved = new Map();
  const service = {
    project(id) { assert.equal(id, ws.id); return project; },
    store: { event() {}, setting(key, value) { if (value !== undefined) saved.set(key, value); return saved.get(key); } }
  };
  const capabilities = await createCapabilities({ service, instanceRoot: path.join(temp, 'private'), engines: [reversePlugin] });
  t.after(() => capabilities.close());
  const entries = (await capabilities.list({ projectId: ws.id, engine: 'reverse' }, { callerRole: 'owner' })).engines[0].capabilities;
  assert.equal(entries.length, 30, 'the 29 tools and reverse.diagnose');
  assert.ok(entries.every(item => item.inputSchema.properties.workspaceId === undefined));
  const status = await capabilities.call({ projectId: ws.id, capability: 'reverse.status' }, { callerRole: 'read' });
  assert.equal(status.structuredContent.processAccessEnabled, false);
  const patch = { path: 'input.bin', expectedSha256: 'a'.repeat(64), patches: [{ offset: 0, expectedHex: '00', replacementHex: '01' }] };
  await assert.rejects(capabilities.call({ projectId: ws.id, capability: 'reverse.patch_copy', input: { ...patch, dryRun: false, confirm: true, outputPath: 'out.bin' } }, { callerRole: 'read' }),
    error => error.code === 'forbidden');
  await assert.rejects(capabilities.call({ projectId: ws.id, capability: 'reverse.memory_read', input: { sessionId: '00000000-0000-4000-8000-000000000000', address: '0x1000' } }, { callerRole: 'write' }),
    error => error.code === 'forbidden' && /owner/.test(error.message));
  await assert.rejects(capabilities.call({ projectId: ws.id, capability: 'reverse.status', input: { workspaceId: 'other' } }, { callerRole: 'read' }));
});

test('Reverse defaults keep process access disabled, settings strict and install nothing', async () => {
  assert.equal(reversePlugin.manifest.ownerOnly, false, 'static tools stay available to members; process and backend tools declare ownerOnly themselves');
  assert.equal(settings.allowProcessAccess, false); assert.equal(settings.allowMemoryWrite, false);
  assert.throws(() => reverseSettingsSchema.parse({ surprise: true }));
  assert.throws(() => reverseSettingsSchema.parse({ maxFileBytes: 1024 }));
  const result = await call('status', { probe: true });
  assert.equal(result.pythonAvailable, false); assert.equal(result.processAccessEnabled, false);
  assert.equal(result.limits.candidatesPerScan, 5000);
  await assert.rejects(call('processes'), /disabled/);
});

test('file tools validate types, boundaries and numeric 64-bit encoding', async () => {
  await fsp.writeFile(path.join(root, 'input.bin'), Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]));
  assert.equal((await call('binary_info', { path: 'input.bin' })).format, 'raw');
  const found = await call('bytes_search', { path: 'input.bin', value: 0x04030201, dataType: 'uint32' });
  assert.deepEqual(found.matches, [0, 4]);
  assert.equal((await call('hex_read', { path: 'input.bin', offset: 7, length: 8 })).length, 1);
  assert.equal((await call('value_codec', { dataType: 'uint64', value: '18446744073709551615' })).hex, 'ffffffffffffffff');
  await assert.rejects(call('value_codec', { value: 1, hex: '01000000' }), /exactly one/);
  await assert.rejects(call('value_codec', { dataType: 'uint64', hex: '01' }), /Byte count/);
  await assert.rejects(call('hex_read', { path: 'input.bin', offset: 100 }), /beyond/);
  await assert.rejects(call('hex_read', { path: 'input.bin', length: 1e9 }));
  await assert.rejects(call('hex_read', { path: 'input.bin', injectedArgument: true }));
});

test('workspace containment and credential guards apply to binary readers', async () => {
  await fsp.writeFile(path.join(root, '.env'), 'synthetic-test-data');
  await assert.rejects(call('binary_info', { path: '../outside.bin' }), /escapes/);
  await assert.rejects(call('binary_info', { path: '.env' }), /protected/);
  await assert.rejects(call('binary_info', { path: '.' }), /regular file|EISDIR|EACCES|EPERM/);
});

test('binary readers reject escaping reparse points', async t => {
  const outside = path.join(temp, 'outside'); await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'data.bin'), 'outside');
  try { await fsp.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(error.code); return; } throw error; }
  await assert.rejects(call('binary_info', { path: 'escape/data.bin' }), /symlink|reparse/);
});

test('patches default to dry-run, require confirmation and never overwrite source or existing outputs', async () => {
  const source = Buffer.from('abcdefgh'); await fsp.writeFile(path.join(root, 'original.bin'), source);
  const args = { path: 'original.bin', expectedSha256: sha256(source), outputPath: 'patched.bin', patches: [{ offset: 2, expectedHex: '6364', replacementHex: '4344' }] };
  assert.equal((await call('patch_copy', args)).dryRun, true);
  assert.equal(fs.existsSync(path.join(root, 'patched.bin')), false);
  await assert.rejects(call('patch_copy', { ...args, dryRun: false }), /confirm/);
  const result = await call('patch_copy', { ...args, dryRun: false, confirm: true });
  assert.equal(result.sourceUnchanged, true);
  assert.equal(await fsp.readFile(path.join(root, 'original.bin'), 'utf8'), 'abcdefgh');
  assert.equal(await fsp.readFile(path.join(root, 'patched.bin'), 'utf8'), 'abCDefgh');
  await assert.rejects(call('patch_copy', { ...args, dryRun: false, confirm: true }), /EEXIST/);
  await assert.rejects(call('patch_copy', { ...args, outputPath: 'original.bin', dryRun: false, confirm: true }), /EEXIST/);
  await assert.rejects(call('patch_copy', { ...args, outputPath: '../outside.bin', dryRun: false, confirm: true }), /escapes/);
  const patchAudits = audit.filter(item => item.action.startsWith('patch_copy'));
  assert.ok(patchAudits.length >= 2);
  assert.ok(patchAudits.every(item => !JSON.stringify(item).includes('6364')));
});

test('file-size budgets and read-only mutation guards are enforced', async () => {
  settings = reverseSettingsSchema.parse({ maxFileBytes: 1048576 });
  await fsp.writeFile(path.join(root, 'large.bin'), Buffer.alloc(1048577));
  await assert.rejects(call('binary_info', { path: 'large.bin' }), /maxFileBytes/);
  profile = 'readOnly';
  const bytes = Buffer.from('abcdefgh');
  const args = { path: 'original.bin', expectedSha256: sha256(bytes), patches: [{ offset: 0, expectedHex: '61', replacementHex: '41' }], outputPath: 'forbidden.bin', dryRun: false, confirm: true };
  await assert.rejects(call('patch_copy', args), /Read-only/);
  assert.equal(fs.existsSync(path.join(root, 'forbidden.bin')), false);
  profile = 'fullAccess'; settings = reverseSettingsSchema.parse({});
});

test('process-access revocation and write-off defaults are checked on existing sessions', async () => {
  const current = context.state.sessions.create(ws, { pid: 10, creationTime: '1', imagePath: 'fixture', pointerSize: 8 });
  await assert.rejects(call('memory_read', { sessionId: current.id, address: '0x1000' }), /disabled/);
  settings = reverseSettingsSchema.parse({ allowProcessAccess: true });
  await assert.rejects(call('memory_write', { sessionId: current.id, address: '0x1000', expectedHex: '01', replacementHex: '02', dryRun: false, confirm: true }), /writes are disabled/);
  profile = 'balanced';
  await assert.rejects(call('memory_read', { sessionId: current.id, address: '0x1000' }), /only to the owner/);
  profile = 'fullAccess';
  await assert.rejects(call('memory_read', { sessionId: current.id, address: '0x10000000000000000' }), /64 bits/);
  assert.equal((await call('session_close', { sessionId: current.id })).closed, true);
  settings = reverseSettingsSchema.parse({});
});

test.after(async () => { await reversePlugin.deactivate(context); await fsp.rm(temp, { recursive: true, force: true }); });
