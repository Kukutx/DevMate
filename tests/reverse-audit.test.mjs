import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { patchCopy, sha256 } from '../runtime/engines/reverse-files.mjs';
import { PYTHON_SOURCE, pythonExecutable, runNative, stopNativeHelpers } from '../runtime/engines/reverse-native.mjs';
import { reversePlugin, reverseSettingsSchema } from '../runtime/engines/reverse.mjs';
import { findExecutable, resolveWorkspacePath } from '../runtime/engines/engine-io.mjs';
import { createEngineState } from '../runtime/engine-state.mjs';
const contexts = [];

const python = findExecutable(['python', 'python3']);
function contextFor(workspace) {
  let profile = 'fullAccess', enabled = true;
  const context = {
    state: createEngineState('devmate.reverse'),
    settings: reverseSettingsSchema.parse({ pythonPath: python || '' }),
    caller: () => 'owner',
    assertOwner(action) { if (this.caller() !== 'owner') throw new Error(action + ' is available only to the owner'); },
    assertCanMutate() { if (profile === 'readOnly') throw new Error('Read-only profile'); },
    revoke() { profile = 'readOnly'; },
    disable() { enabled = false; },
    assertActive() { if (!enabled) throw new Error('Reverse engine is disabled'); },
    audit: async () => {},
    workspace: {
      get(id, { writable = false } = {}) {
        if (id && id !== workspace.id) throw new Error('Unknown workspace');
        if (writable && profile === 'readOnly') throw new Error('Read-only workspace');
        return workspace;
      },
      resolve: resolveWorkspacePath
    },
    executables: {
      find: findExecutable,
      assertAllowed(executable) {
        assert.ok(reversePlugin.manifest.permissions.executablePatterns.some(pattern => new RegExp(pattern, 'i').test(path.basename(executable))));
      }
    }
  };
  contexts.push(context);
  return context;
}

test('Python role cannot be satisfied by another executable in the plugin allowlist', () => {
  for (const name of ['rizin.exe', 'radare2.exe', 'r2']) {
    const executable = path.join(os.tmpdir(), name);
    const context = contextFor({ id: 'audit', root: os.tmpdir() });
    context.settings = { ...context.settings, pythonPath: executable };
    context.executables.find = () => executable;
    assert.throws(() => pythonExecutable(context), /Python executable/i, name);
  }
});

test('Python executable configuration rejects relative paths before PATH discovery', () => {
  const context = contextFor({ id: 'audit', root: os.tmpdir() });
  context.settings = { ...context.settings, pythonPath: 'relative/python.exe' };
  context.executables.find = () => path.join(os.tmpdir(), 'python.exe');
  assert.throws(() => pythonExecutable(context), /absolute/i);
});

for (const change of ['permission', 'disable', 'cancel', 'workspace']) {
  test(`patch-copy revalidates ${change} after its asynchronous intent audit`, async t => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-audit-'));
    t.after(() => fsp.rm(root, { recursive: true, force: true }));
    const workspace = { id: 'audit', root };
    const context = contextFor(workspace);
    const source = Buffer.from('original');
    await fsp.writeFile(path.join(root, 'source.bin'), source);
    const controller = new AbortController();
    context.signal = controller.signal;
    context.audit = async action => {
      if (action !== 'patch_copy_intent') return;
      if (change === 'permission') context.revoke();
      if (change === 'disable') context.disable();
      if (change === 'cancel') controller.abort(new Error('Fixture request cancelled'));
      if (change === 'workspace') context.workspace.get = () => { throw new Error('Workspace access revoked'); };
    };
    const args = { path: 'source.bin', outputPath: 'output.bin', expectedSha256: sha256(source), patches: [{ offset: 0, expectedHex: '6f', replacementHex: '4f' }], dryRun: false, confirm: true };
    await assert.rejects(patchCopy(context, workspace, args), /Read-only|disabled|cancelled|revoked/i);
    assert.equal(fs.existsSync(path.join(root, 'output.bin')), false);
    assert.deepEqual(await fsp.readFile(path.join(root, 'source.bin')), source);
  });
}

for (const change of ['cancel', 'disable']) {
  test(`native helper revalidates ${change} after its asynchronous intent audit`, { skip: !python }, async () => {
    const context = contextFor({ id: 'audit', root: os.tmpdir() });
    const controller = new AbortController();
    context.signal = controller.signal;
    context.audit = async action => {
      if (action !== 'native_intent') return;
      if (change === 'cancel') controller.abort(new Error('Fixture request cancelled'));
      else context.disable();
    };
    await assert.rejects(runNative(context, 'status'), /cancelled|disabled/i);
  });
}

test.after(() => Promise.all(contexts.map(context => stopNativeHelpers(context.state.native))));


test('native cancellation after spawn rejects and removes its abort listener', { skip: !python }, async t => {
  const context = contextFor({ id: 'audit', root: os.tmpdir() });
  const controller = new AbortController();
    context.signal = controller.signal;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  let subscribed = false;
  t.mock.method(controller.signal, 'addEventListener', (name, listener, options) => {
    originalAdd(name, listener, options);
    if (name === 'abort') {
      subscribed = true;
      queueMicrotask(() => controller.abort(new Error('Fixture cancellation after spawn')));
    }
  });
  await assert.rejects(runNative(context, 'status'), /cancelled/i);
  assert.equal(subscribed, true, 'Exercise cancellation of a real spawned helper, not only preflight rejection');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('native successful calls remove listeners and leave an already-cancelled request untouched', { skip: !python }, async () => {
  const context = contextFor({ id: 'audit', root: os.tmpdir() });
  const controller = new AbortController();
    context.signal = controller.signal;
  await runNative(context, 'status');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  controller.abort(new Error('Fixture preflight cancellation'));
  let audited = false;
  context.audit = async () => { audited = true; };
  await assert.rejects(runNative(context, 'status'), /preflight cancellation/);
  assert.equal(audited, false);
});

async function pythonContract(t, body) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-oracle-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'contract.py');
  await fsp.writeFile(script, PYTHON_SOURCE.replace("if __name__ == '__main__':", 'if False:') + body);
  const result = spawnSync(python, ['-I', '-B', script], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /ok/);
}

test('seeded differential scans match a bytewise oracle across regions, alignment and continuation', { skip: !python }, t => pythonContract(t, String.raw`
import random
rng = random.Random(20260917)
base = 0x1003
for case in range(80):
    kind = rng.choice(['uint8', 'int16', 'uint32', 'uint64', 'float64'])
    endian = rng.choice(['little', 'big'])
    request = {'dataType': kind, 'endian': endian}
    fmt = codec(request)
    target = (2**63 + 17) if kind == 'uint64' else 12.25 if kind == 'float64' else 7
    memory = bytearray(rng.randbytes(517))
    for index in range(20):
        fmt.pack_into(memory, rng.randrange(0, len(memory) - fmt.size + 1), target)
    alignment = rng.choice([1, 2, 4, 8])
    def memory_region(handle, address):
        begin = ((address - base) // 77) * 77
        return {'base': base + begin, 'size': min(77, len(memory) - begin), 'readable': True, 'writable': True}
    def read_raw(handle, address, size):
        offset = address - base
        if offset < 0 or offset + size > len(memory): raise ValueError('Test range escaped')
        return bytes(memory[offset:offset + size])
    start = rng.randrange(0, 20)
    expected = [base + i for i in range(start, len(memory) - fmt.size + 1) if (base + i) % alignment == 0 and fmt.unpack_from(memory, i)[0] == target]
    observed, cursor = [], base + start
    for page_index in range(200):
        result = scan_memory({**request, 'address': hex(cursor), 'length': base + len(memory) - cursor, 'comparison': 'equal', 'value': str(target) if kind == 'uint64' else target, 'alignment': alignment, 'maxCandidates': 3}, None, {'pointerSize': 8})
        observed.extend(int(item['address'], 0) for item in result['candidates'])
        if result['nextAddress'] is None:
            assert result['complete'], result
            break
        next_cursor = int(result['nextAddress'], 0)
        assert next_cursor > cursor, result
        cursor = next_cursor
    else: raise AssertionError('Non-terminating pagination')
    assert observed == expected, (case, kind, endian, observed, expected)
print('ok: 80 deterministic scan/oracle comparisons')
`));

test('known pointer chains reject a null pointee before adding a positive offset', { skip: !python }, t => pythonContract(t, String.raw`
def read_raw(handle, address, size): return bytes(size)
try: pointer_chain({'address': '0x1000', 'offsets': [16]}, None, {'pointerSize': 8})
except ValueError as error: assert 'null' in str(error).lower()
else: raise AssertionError('A null pointee plus an offset is not a valid pointer chain')
print('ok')
`));
