import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { z } from 'zod';
import { reversePlugin, reverseSettingsSchema } from '../gateway/plugins/reverse.mjs';
import { resolveWorkspacePath } from '../gateway/plugins/plugin-runtime.mjs';
import { ownerOnlyTool, validateToolRegistration } from '../gateway/tool-policy.mjs';
import { reverseSessions } from '../gateway/plugins/reverse-sessions.mjs';
import { sha256 } from '../gateway/plugins/reverse-files.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-plugin-'));
const root = path.join(temp, 'workspace');
await fsp.mkdir(root);
const ws = { id: 'reverse-test', root, name: 'Reverse test' };
let settings = reverseSettingsSchema.parse({}), profile = 'fullAccess';
const tools = new Map(), audit = [];
const context = {
  get settings() { return settings; },
  server: { registerTool(name, config, handler) { tools.set(name, { config, handler }); } },
  toolText: value => value,
  permissionProfile: () => profile,
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

test('all 29 tools have serializable schemas, explicit policies and owner restriction', () => {
  assert.equal(tools.size, 29);
  for (const [name, entry] of tools) {
    const policy = validateToolRegistration(name, entry.config);
    assert.equal(policy.ok, true, `${name}: ${policy.errors.join(', ')}`);
    assert.equal(ownerOnlyTool(name), true, name);
    assert.equal(policy.capability, 'admin');
    assert.doesNotThrow(() => z.toJSONSchema(z.object(entry.config.inputSchema)), name);
  }
});

test('reverse plugin is opt-in, strict and installs nothing', async () => {
  assert.equal(reversePlugin.manifest.defaultEnabled, false);
  assert.equal(settings.allowProcessAccess, false); assert.equal(settings.allowMemoryWrite, false);
  assert.throws(() => reverseSettingsSchema.parse({ surprise: true }));
  assert.throws(() => reverseSettingsSchema.parse({ maxFileBytes: 1024 }));
  const result = await call('reverse_status', { probe: true });
  assert.equal(result.pythonAvailable, false); assert.equal(result.processAccessEnabled, false);
  assert.equal(result.limits.candidatesPerScan, 5000);
  await assert.rejects(call('reverse_processes'), /disabled/);
});

test('file tools validate types, boundaries and numeric 64-bit encoding', async () => {
  await fsp.writeFile(path.join(root, 'input.bin'), Buffer.from([1, 2, 3, 4, 1, 2, 3, 4]));
  assert.equal((await call('reverse_binary_info', { path: 'input.bin' })).format, 'raw');
  const found = await call('reverse_bytes_search', { path: 'input.bin', value: 0x04030201, dataType: 'uint32' });
  assert.deepEqual(found.matches, [0, 4]);
  assert.equal((await call('reverse_hex_read', { path: 'input.bin', offset: 7, length: 8 })).length, 1);
  assert.equal((await call('reverse_value_codec', { dataType: 'uint64', value: '18446744073709551615' })).hex, 'ffffffffffffffff');
  await assert.rejects(call('reverse_value_codec', { value: 1, hex: '01000000' }), /exactly one/);
  await assert.rejects(call('reverse_value_codec', { dataType: 'uint64', hex: '01' }), /Byte count/);
  await assert.rejects(call('reverse_hex_read', { path: 'input.bin', offset: 100 }), /beyond/);
  await assert.rejects(call('reverse_hex_read', { path: 'input.bin', length: 1e9 }));
  await assert.rejects(call('reverse_hex_read', { path: 'input.bin', injectedArgument: true }));
});

test('workspace containment and credential guards apply to binary readers', async () => {
  await fsp.writeFile(path.join(root, '.env'), 'synthetic-test-data');
  await assert.rejects(call('reverse_binary_info', { path: '../outside.bin' }), /escapes/);
  await assert.rejects(call('reverse_binary_info', { path: '.env' }), /protected/);
  await assert.rejects(call('reverse_binary_info', { path: '.' }), /regular file|EISDIR|EACCES|EPERM/);
});

test('binary readers reject escaping reparse points', async t => {
  const outside = path.join(temp, 'outside'); await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, 'data.bin'), 'outside');
  try { await fsp.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(error.code); return; } throw error; }
  await assert.rejects(call('reverse_binary_info', { path: 'escape/data.bin' }), /symlink|reparse/);
});

test('patches default to dry-run, require confirmation and never overwrite source or existing outputs', async () => {
  const source = Buffer.from('abcdefgh'); await fsp.writeFile(path.join(root, 'original.bin'), source);
  const args = { path: 'original.bin', expectedSha256: sha256(source), outputPath: 'patched.bin', patches: [{ offset: 2, expectedHex: '6364', replacementHex: '4344' }] };
  assert.equal((await call('reverse_patch_copy', args)).dryRun, true);
  assert.equal(fs.existsSync(path.join(root, 'patched.bin')), false);
  await assert.rejects(call('reverse_patch_copy', { ...args, dryRun: false }), /confirm/);
  const result = await call('reverse_patch_copy', { ...args, dryRun: false, confirm: true });
  assert.equal(result.sourceUnchanged, true);
  assert.equal(await fsp.readFile(path.join(root, 'original.bin'), 'utf8'), 'abcdefgh');
  assert.equal(await fsp.readFile(path.join(root, 'patched.bin'), 'utf8'), 'abCDefgh');
  await assert.rejects(call('reverse_patch_copy', { ...args, dryRun: false, confirm: true }), /EEXIST/);
  await assert.rejects(call('reverse_patch_copy', { ...args, outputPath: 'original.bin', dryRun: false, confirm: true }), /EEXIST/);
  await assert.rejects(call('reverse_patch_copy', { ...args, outputPath: '../outside.bin', dryRun: false, confirm: true }), /escapes/);
  const patchAudits = audit.filter(item => item.action.startsWith('patch_copy'));
  assert.ok(patchAudits.length >= 2);
  assert.ok(patchAudits.every(item => !JSON.stringify(item).includes('6364')));
});

test('file-size budgets and read-only mutation guards are enforced', async () => {
  settings = reverseSettingsSchema.parse({ maxFileBytes: 1048576 });
  await fsp.writeFile(path.join(root, 'large.bin'), Buffer.alloc(1048577));
  await assert.rejects(call('reverse_binary_info', { path: 'large.bin' }), /maxFileBytes/);
  profile = 'readOnly';
  const bytes = Buffer.from('abcdefgh');
  const args = { path: 'original.bin', expectedSha256: sha256(bytes), patches: [{ offset: 0, expectedHex: '61', replacementHex: '41' }], outputPath: 'forbidden.bin', dryRun: false, confirm: true };
  await assert.rejects(call('reverse_patch_copy', args), /Read-only/);
  assert.equal(fs.existsSync(path.join(root, 'forbidden.bin')), false);
  profile = 'fullAccess'; settings = reverseSettingsSchema.parse({});
});

test('process-access revocation and write-off defaults are checked on existing sessions', async () => {
  const current = reverseSessions.create(ws, { pid: 10, creationTime: '1', imagePath: 'fixture', pointerSize: 8 });
  await assert.rejects(call('reverse_memory_read', { sessionId: current.id, address: '0x1000' }), /disabled/);
  settings = reverseSettingsSchema.parse({ allowProcessAccess: true });
  await assert.rejects(call('reverse_memory_write', { sessionId: current.id, address: '0x1000', expectedHex: '01', replacementHex: '02', dryRun: false, confirm: true }), /writes are disabled/);
  profile = 'balanced';
  await assert.rejects(call('reverse_memory_read', { sessionId: current.id, address: '0x1000' }), /fullAccess/);
  profile = 'fullAccess';
  await assert.rejects(call('reverse_memory_read', { sessionId: current.id, address: '0x10000000000000000' }), /64 bits/);
  assert.equal((await call('reverse_session_close', { sessionId: current.id })).closed, true);
  settings = reverseSettingsSchema.parse({});
});

test.after(async () => { await reversePlugin.deactivate(); await fsp.rm(temp, { recursive: true, force: true }); });
