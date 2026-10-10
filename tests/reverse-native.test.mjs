import { createEngineState } from '../runtime/engine-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import test from 'node:test';
import { findExecutable } from '../runtime/engines/engine-io.mjs';
import { PYTHON_SOURCE, runNative, stopNativeHelpers } from '../runtime/engines/reverse-native.mjs';
import { reversePlugin, reverseSettingsSchema } from '../runtime/engines/reverse.mjs';

const python = findExecutable(['python', 'python3']);
const ws = { id: 'native-test', root: os.tmpdir() };
const tools = new Map(), audits = [];
const context = {
  state: createEngineState('devmate.reverse'), assertActive() {},
  settings: reverseSettingsSchema.parse({ pythonPath: python || '', allowProcessAccess: true, allowMemoryWrite: true }),
  caller: () => 'owner', assertOwner() {}, assertCanMutate: () => {},
  audit: async (action, payload) => { audits.push({ action, payload }); },
  executables: { find: () => python, assertAllowed: () => {} },
  workspace: { get: () => ws },
  server: { registerTool(name, config, handler) { tools.set(name, { config, handler }); } },
  toolText: value => value
};
reversePlugin.activate(context);
const call = (name, args = {}) => tools.get(name).handler(args);

test.beforeEach(() => { context.state.native = createEngineState('devmate.reverse').native; });

test('native capacity and plugin shutdown fence operations still awaiting audit', { skip: !python }, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gated = { ...context, audit: () => gate };
  const first = runNative(gated, 'status'), second = runNative(gated, 'status');
  await assert.rejects(runNative(context, 'status'), /capacity/);
  const stopped = stopNativeHelpers(context.state.native);
  release();
  await stopped;
  const results = await Promise.allSettled([first, second]);
  assert.ok(results.every(result => result.status === 'rejected' && /stopped/.test(result.reason.message)));
});

test('native execution rechecks permission after asynchronous audit', { skip: !python }, async () => {
  let release, role = 'owner';
  const gate = new Promise(resolve => { release = resolve; });
  const gated = { ...context, audit: () => gate, caller: () => role, assertOwner(action) { if (this.caller() !== 'owner') throw new Error(action + ' is available only to the owner'); } };
  const pending = runNative(gated, 'status');
  role = 'write';
  release();
  await assert.rejects(pending, /only to the owner/);
});

test('fixed helper source remains small enough for a Windows command line', () => {
  assert.ok(Buffer.byteLength(PYTHON_SOURCE) < 28000, `Helper is ${Buffer.byteLength(PYTHON_SOURCE)} bytes; split the transport before growing it further`);
});

test('fixed Python helper runs in isolated mode and reports missing optional engines', { skip: !python, timeout: 20000 }, async t => {
  const result = await runNative(context, 'status');
  t.diagnostic(JSON.stringify(result));
  assert.equal(result.platform, process.platform === 'win32' ? 'win32' : process.platform);
  assert.equal(typeof result.capstoneAvailable, 'boolean');
  assert.ok([4, 8].includes(result.pointerSize));
  if (!result.capstoneAvailable) await assert.rejects(runNative(context, 'disassemble', { hex: '90', architecture: 'x86_64', address: '0x1000', count: 1 }), /capstone/);
  else {
    const decoded = await runNative(context, 'disassemble', { hex: '90c3', architecture: 'x86_64', address: '0x1000', count: 2 });
    assert.deepEqual(decoded.instructions.map(item => item.mnemonic), ['nop', 'ret']);
    assert.equal(decoded.bytesConsumed, 2);
  }
});

test('native numeric comparisons and wildcard matching work independently of the OS', { skip: !python }, () => {
  const code = PYTHON_SOURCE.replace("if __name__ == '__main__':", 'if False:') + String.raw`
r = {'dataType': 'uint64', 'comparison': 'equal', 'value': '18446744073709551615'}
compare, value = prepare_comparison(r)
assert compare(18446744073709551615) and not compare(18446744073709551614)
compare, value = prepare_comparison({'dataType': 'float32', 'comparison': 'equal', 'value': '1.5', 'epsilon': 0.01})
assert compare(1.505) and not compare(1.6)
for mode, current, previous, target in [('increased_by', 15, 10, 5), ('decreased_by', 5, 10, 5), ('changed', 11, 10, None), ('unchanged', 10, 10, None)]:
    query = {'dataType': 'int32', 'comparison': mode}
    if target is not None: query['value'] = target
    compare, value = prepare_comparison(query, True)
    assert compare(current, previous)
regex, size = pattern_regex('41 ?? F? 5A')
assert size == 4 and regex.search(bytes.fromhex('004100fe5a00')).start() == 1
memory = bytearray(600000)
struct.pack_into('<I', memory, 262142, 0x12345678)
struct.pack_into('<I', memory, 300000, 0x12345678)
def memory_region(handle, address):
    base, end = (0, 262144) if address < 262144 else (262144, len(memory))
    return {'base': base, 'size': end - base, 'readable': True, 'writable': True}
def read_raw(handle, address, size):
    return bytes(memory[address:address + size])
result = scan_memory({'address': '0x0', 'length': len(memory), 'dataType': 'uint32', 'comparison': 'equal', 'value': 0x12345678, 'alignment': 1}, None, {'pointerSize': 8})
assert [int(item['address'], 0) for item in result['candidates']] == [262142, 300000], result
assert result['complete']
limited = scan_memory({'address': '0x0', 'length': len(memory), 'dataType': 'uint32', 'comparison': 'unknown', 'maxCandidates': 2}, None, {'pointerSize': 8})
assert len(limited['candidates']) == 2 and limited['stopReason'] == 'candidate_limit' and limited['nextAddress'] == '0x8'
struct.pack_into('<I', memory, 100, 0x12345678)
def memory_region(handle, address):
    base, end = (0, 262144) if address < 262144 else (262144, len(memory))
    return {'base': base, 'size': end - base, 'readable': address < 262144, 'writable': True}
def read_raw(handle, address, size):
    if address + size > 262144: raise ValueError('unreadable next region')
    return bytes(memory[address:address + size])
partial = scan_memory({'address': '0x0', 'length': len(memory), 'dataType': 'uint32', 'comparison': 'equal', 'value': 0x12345678, 'alignment': 1}, None, {'pointerSize': 8})
assert [int(item['address'], 0) for item in partial['candidates']] == [100], partial
assert not partial['complete'] and partial['skippedBytes'] == len(memory) - 262144
assert partial['bytesRead'] == 262144
print('numeric, wildcard, chunk/region-boundary, unreadable-overlap and candidate-budget checks passed')
`;
  const result = spawnSync(python, ['-I', '-B', '-c', "import sys; exec(compile(sys.stdin.read(), '<reverse-test>', 'exec'))"], { input: code, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error || ''}`);
});

const FIXTURE = String.raw`
import ctypes as C, json, os, struct, sys
memory = C.create_string_buffer(600000)
struct.pack_into('<i', memory, 16, 100)
struct.pack_into('<i', memory, 20, 100)
struct.pack_into('<f', memory, 24, 1.5)
struct.pack_into('<Q', memory, 32, 0xf123456789abcdef)
C.memmove(C.addressof(memory) + 262142, bytes.fromhex('414200fe5a'), 5)
pointer = C.c_void_p(C.addressof(memory))
print(json.dumps({'pid': os.getpid(), 'address': hex(C.addressof(memory)), 'pointerAddress': hex(C.addressof(pointer)), 'size': len(memory)}), flush=True)
for line in sys.stdin:
    command = json.loads(line)
    if command['op'] == 'set': struct.pack_into('<i', memory, command['offset'], command['value'])
    print(json.dumps({'value': struct.unpack_from('<i', memory, command.get('offset', 16))[0]}), flush=True)
`;

test('Windows integration: only the test-owned process is inspected and changed', { skip: !python || process.platform !== 'win32', timeout: 90000 }, async t => {
  const status = await runNative(context, 'status');
  if (!status.processMemory) { t.skip('64-bit Python is required'); return; }
  const fixture = spawn(python, ['-I', '-B', '-u', '-c', FIXTURE], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const output = createInterface({ input: fixture.stdout });
  const lines = output[Symbol.asyncIterator]();
  let stderr = '';
  fixture.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(0, 8192); });
  t.after(async () => {
    output.close();
    if (fixture.exitCode === null && fixture.signalCode === null) await new Promise(resolve => { fixture.once('close', resolve); fixture.kill('SIGKILL'); });
    await reversePlugin.deactivate(context);
  });
  const next = async () => {
    const line = await lines.next();
    assert.equal(line.done, false, stderr || 'Fixture exited unexpectedly');
    return JSON.parse(line.value);
  };
  const command = async data => { fixture.stdin.write(JSON.stringify(data) + '\n'); return next(); };
  const target = await next();
  const address = offset => `0x${(BigInt(target.address) + BigInt(offset)).toString(16)}`;
  const opened = await call('session_open', { pid: target.pid });
  const bound = { sessionId: opened.sessionId };
  assert.equal(opened.identity.pid, target.pid);

  await t.test('identity, process enumeration, modules, regions and read', async () => {
    const processes = await call('processes', { name: 'python', limit: 500 });
    assert.ok(processes.entries.some(item => item.pid === target.pid));
    const modules = await call('modules', bound);
    assert.ok(modules.entries.some(item => /python/i.test(item.name)));
    const regions = await call('memory_regions', { ...bound, address: target.address, limit: 1 });
    assert.equal(regions.entries[0].readable, true);
    assert.equal((await call('memory_read', { ...bound, address: address(16), length: 4 })).hex, '64000000');
    await assert.rejects(runNative(context, 'read', { pid: target.pid, identity: { ...opened.identity, creationTime: '0' }, address: address(16), length: 4 }), /identity changed/);
    await assert.rejects(call('memory_write', { ...bound, address: modules.entries[0].base, expectedHex: '4d', replacementHex: '4d' }), /private.*non-executable/);
  });

  let scan;
  await t.test('exact/unknown scans, float64 precision and cross-chunk wildcard search', async () => {
    scan = await call('value_scan', { ...bound, address: target.address, length: target.size, dataType: 'int32', value: 100 });
    assert.equal(scan.total, 2); assert.equal(scan.metadata.complete, true);
    const unknown = await call('value_scan', { ...bound, address: target.address, length: 64, dataType: 'int32', comparison: 'unknown', maxCandidates: 2 });
    assert.equal(unknown.total, 2); assert.equal(unknown.metadata.stopReason, 'candidate_limit');
    const wide = await call('value_scan', { ...bound, address: address(32), length: 8, dataType: 'uint64', value: '17375808098319191535' });
    assert.equal(wide.total, 1); assert.equal(wide.entries[0].value, '17375808098319191535');
    const floats = await call('value_scan', { ...bound, address: address(24), length: 4, dataType: 'float32', value: 1.5 });
    assert.equal(floats.total, 1);
    const bytes = await call('memory_search', { ...bound, address: target.address, length: target.size, pattern: '41 42 ?? F? 5A' });
    assert.equal(bytes.complete, true); assert.equal(bytes.candidates[0].address, address(262142));
    await assert.rejects(call('value_scan', { ...bound, address: target.address, length: 4, value: 100 }), /Maximum 4/);
    await call('scan_close', { ...bound, scanId: unknown.scanId });
  });

  await t.test('revisioned rescans use previous values and reject stale revisions', async () => {
    await command({ op: 'set', offset: 16, value: 150 });
    const result = await call('value_rescan', { ...bound, scanId: scan.scanId, expectedRevision: 1, comparison: 'increased_by', value: 50 });
    assert.equal(result.total, 1); assert.equal(result.entries[0].value, 150); assert.equal(result.revision, 2);
    await assert.rejects(call('value_rescan', { ...bound, scanId: scan.scanId, expectedRevision: 1, comparison: 'changed' }), /revision mismatch/);
    const stored = await call('scan_results', { ...bound, scanId: scan.scanId });
    assert.equal(stored.entries[0].value, 150);
    const baseline = context.state.sessions.get(ws, bound.sessionId).scans.get(scan.scanId);
    baseline.metadata.complete = false; // Model an earlier unreadable-candidate loss.
    const subsequent = await call('value_rescan', { ...bound, scanId: scan.scanId, expectedRevision: 2, comparison: 'unchanged' });
    assert.equal(subsequent.metadata.complete, false, 'later reads cannot erase an earlier coverage gap');
  });

  await t.test('known pointer chains and one-level references resolve without mutation', async () => {
    const chain = await call('pointer_chain', { ...bound, address: target.pointerAddress, offsets: [16] });
    assert.equal(chain.finalAddress, address(16));
    const references = await call('pointer_references', { ...bound, address: target.pointerAddress, length: 8, targetAddress: address(16), maxOffset: 16 });
    assert.equal(references.references[0].offset, '16');
  });

  await t.test('write plans, verified writes, restoration and conflict refusal', async () => {
    const args = { ...bound, address: address(16), expectedHex: '96000000', replacementHex: 'c8000000' };
    assert.equal((await call('memory_write', args)).dryRun, true);
    assert.equal((await command({ op: 'peek', offset: 16 })).value, 150);
    const written = await call('memory_write', { ...args, dryRun: false, confirm: true });
    assert.equal(written.verified, true); assert.equal(written.atomic, false); assert.ok(written.writeId);
    assert.equal((await command({ op: 'peek', offset: 16 })).value, 200);
    const restored = await call('memory_restore', { ...bound, writeId: written.writeId, dryRun: false, confirm: true });
    assert.equal(restored.verified, true); assert.equal((await command({ op: 'peek', offset: 16 })).value, 150);
    const again = await call('memory_write', { ...args, dryRun: false, confirm: true });
    await command({ op: 'set', offset: 16, value: 300 });
    await assert.rejects(call('memory_restore', { ...bound, writeId: again.writeId, dryRun: false, confirm: true }), /Expected bytes mismatch/);
    assert.equal((await command({ op: 'peek', offset: 16 })).value, 300);
    assert.ok(audits.every(item => !JSON.stringify(item).includes('replacementHex')));
  });

  assert.equal((await call('session_close', bound)).closed, true);
  assert.equal(context.state.sessions.entries.size, 0);
});

test.after(async () => { await stopNativeHelpers(context.state.native); context.state.sessions.clear(); });
