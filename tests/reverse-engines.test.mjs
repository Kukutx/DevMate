import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { ENGINE_PYTHON_SOURCE, analyzeWithEngine, binaryKind, codeCommand, engineEnvironment, inspectWithEngine, parseEngineJson, queryCli, reverseToolchain, stopReverseEngines, __test } from '../gateway/plugins/reverse-engines.mjs';
import { PARSER_SOURCE } from '../gateway/plugins/reverse-parser-source.mjs';
import { reversePlugin, reverseSettingsSchema } from '../gateway/plugins/reverse.mjs';
import { findExecutable, resolveWorkspacePath } from '../gateway/plugins/plugin-runtime.mjs';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-engine-tests-'));
const workspace = { id: 'engine-tests', name: 'Engine tests', root: temp };
const python = findExecutable(['python', 'python3']);
const context = {
  settings: reverseSettingsSchema.parse({ pythonPath: python || '' }),
  permissionProfile: () => 'fullAccess', assertCanMutate: () => {}, audit: async () => {},
  workspace: { get: () => workspace, resolve: resolveWorkspacePath },
  executables: {
    find: findExecutable,
    assertAllowed(executable) {
      if (!reversePlugin.manifest.permissions.executablePatterns.some(pattern => new RegExp(pattern, 'i').test(path.basename(executable)))) throw new Error('Unexpected executable');
    }
  }
};
const noEngines = { ...context, executables: { find: () => null, assertAllowed: () => {} } };
await fsp.writeFile(path.join(temp, 'raw.bin'), 'not an executable');

test('engine settings are strict, optional and do not change process-write defaults', () => {
  const settings = reverseSettingsSchema.parse({});
  assert.equal(settings.binaryEngine, 'auto');
  assert.equal(settings.allowBuiltinFallback, true);
  assert.equal(settings.allowMemoryWrite, false);
  assert.throws(() => reverseSettingsSchema.parse({ binaryEngine: 'custom-shell' }));
  assert.throws(() => reverseSettingsSchema.parse({ analysisTimeoutMs: 9999999 }));
});

test('toolchain distinguishes not found, not probed and missing installation with actionable guidance', async () => {
  const result = await reverseToolchain(noEngines);
  assert.equal(result.pythonFound, false);
  assert.equal(result.engines.rizin.found, false);
  assert.equal(result.engines.rizin.verified, 'not probed');
  assert.equal(result.ghidraInstallationFound, false);
  assert.match(result.guidance.pyghidra, /JDK/);
  assert.equal(result.automaticInstallation, false);
});

test('auto fallback and explicit built-in selection are visible and optional', async () => {
  const result = await inspectWithEngine(noEngines, workspace, { path: 'raw.bin' });
  assert.equal(result.backend.engine, 'builtin');
  assert.equal(result.backend.fallback, true);
  const explicit = await inspectWithEngine(noEngines, workspace, { path: 'raw.bin', engine: 'builtin' });
  assert.equal(explicit.backend.fallback, false);
  await assert.rejects(inspectWithEngine({ ...noEngines, settings: { ...context.settings, allowBuiltinFallback: false } }, workspace, { path: 'raw.bin' }), /Mature parser unavailable/);
  await assert.rejects(inspectWithEngine(noEngines, workspace, { path: 'raw.bin', engine: 'lief' }), /Python/);
});

test('external analysis keeps workspace and credential-path guards', async () => {
  await fsp.writeFile(path.join(temp, '.env'), 'synthetic-test-only');
  await assert.rejects(analyzeWithEngine(noEngines, workspace, { path: '../outside.bin', query: 'functions' }), /escapes/);
  await assert.rejects(analyzeWithEngine(noEngines, workspace, { path: '.env', query: 'functions' }), /protected/);
  await assert.rejects(analyzeWithEngine({ ...noEngines, permissionProfile: () => 'balanced' }, workspace, { path: 'raw.bin', query: 'functions' }), /fullAccess/);
});

test('fixed code commands reject injection and preserve 64-bit addresses', () => {
  assert.equal(codeCommand('functions'), 'aaa;aflj');
  assert.equal(codeCommand('xrefs', { address: '0xffffffffffffffff' }), 'aaa;axtj @ 0xffffffffffffffff');
  assert.equal(codeCommand('disassembly', { address: '4096', limit: 3 }), 'pdj 3 @ 0x1000');
  for (const address of ['0x1;!calc', 'entry0', '1\nq', '-1']) assert.throws(() => codeCommand('xrefs', { address }));
  assert.throws(() => codeCommand('disassembly', { address: '1', limit: 1001 }));
  assert.throws(() => codeCommand('!anything', { address: '1' }));
});

test('backend JSON never silently rounds unsafe integer addresses', () => {
  assert.deepEqual(parseEngineJson('[{"offset":18446744073709551615,"size":2}]'), [{ offset: '18446744073709551615', size: 2 }]);
  assert.throws(() => parseEngineJson('[{"offset":1e30}]'), /Unsafe/);
  assert.throws(() => parseEngineJson('warning\n[]'));
});

test('external environment does not inherit credentials, workspace imports or runtime injection options', () => {
  const env = engineEnvironment('scratch', { PATH: 'tools', SystemRoot: 'Windows', JAVA_HOME: 'jdk', SECRET_TOKEN: 'test-only', PYTHONPATH: 'workspace', NODE_OPTIONS: 'injected', JAVA_TOOL_OPTIONS: 'injected', LD_PRELOAD: 'injected', HOME: 'normal-profile' });
  assert.equal(env.PATH, 'tools'); assert.equal(env.SystemRoot, 'Windows');
  assert.equal(env.HOME, 'scratch'); assert.equal(env.JAVA_HOME, 'jdk');
  for (const name of ['SECRET_TOKEN', 'PYTHONPATH', 'NODE_OPTIONS', 'JAVA_TOOL_OPTIONS', 'LD_PRELOAD']) assert.equal(env[name], undefined);
});

test('engine registry reserves capacity before audit and fences shutdown before process launch', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const delayed = { ...noEngines, audit: () => gate };
  let ran = false;
  const first = __test.engineTask(delayed, 'test', () => { ran = true; });
  const second = __test.engineTask(delayed, 'test', () => { ran = true; });
  const settled = Promise.allSettled([first, second]);
  await assert.rejects(__test.engineTask(delayed, 'test', () => {}), /capacity/);
  const stopped = stopReverseEngines();
  release();
  const results = await settled;
  await stopped;
  assert.equal(ran, false);
  assert.ok(results.every(r => r.status === 'rejected' && /stopped/.test(r.reason.message)));
  assert.equal(__test.activeCount(), 0);
});

test('shared process execution is shell-free and removes temporary state on success/failure', async () => {
  let directory;
  const testContext = { ...noEngines, executables: { ...noEngines.executables, assertAllowed: () => {} } };
  const result = await __test.engineTask(testContext, 'test', async task => {
    directory = task.scratch;
    const result = await task.run(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,pythonpath:process.env.PYTHONPATH}))']);
    return JSON.parse(result.stdout);
  });
  assert.equal(result.cwd, directory); assert.equal(result.home, directory); assert.equal(result.pythonpath, undefined);
  assert.equal(fs.existsSync(directory), false);
  await assert.rejects(__test.engineTask(testContext, 'test', async task => { directory = task.scratch; throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(fs.existsSync(directory), false);
});

test('oversized backend output and timed-out helpers are rejected, not returned as partial success', { timeout: 20000 }, async () => {
  const testContext = { ...noEngines, executables: { ...noEngines.executables, assertAllowed: () => {} } };
  await assert.rejects(__test.engineTask(testContext, 'test', task => task.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(2200000))'])), /exceeded/);
  await assert.rejects(__test.engineTask(testContext, 'test', task => task.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100)), /timed out/);
  assert.equal(__test.activeCount(), 0);
});

test('engine helper source fits Windows command-line bounds and uses current PyGhidra APIs', () => {
  assert.ok(Buffer.byteLength(ENGINE_PYTHON_SOURCE) < 24000);
  assert.match(ENGINE_PYTHON_SOURCE, /program_loader/);
  assert.doesNotMatch(ENGINE_PYTHON_SOURCE, /open_program\(/);
  assert.equal(binaryKind(Buffer.from('7f454c46', 'hex')), 'ELF');
  assert.equal(binaryKind(Buffer.from('cffaedfe', 'hex')), 'Mach-O candidate');
});

test('thin parser adapter distinguishes missing engines from parser failures', { skip: !python }, () => {
  const code = PARSER_SOURCE + String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    filename = str(pathlib.Path(directory) / 'sample.bin')
    pathlib.Path(filename).write_bytes(b'MZtest')
    module_info = lambda engine: {'available': False, 'error': 'fixture missing'}
    result = inspect_binary({'input': filename, 'limit': 2, 'engine': 'auto'})
    assert result['available'] is False
    assert [x['engine'] for x in result['diagnostics']] == ['lief', 'pefile']
    module_info = lambda engine: {'available': True, 'version': 'fixture'}
    def fail(*args): raise ValueError('fixture malformed input')
    lief_info = fail
    try: inspect_binary({'input': filename, 'limit': 2})
    except RuntimeError as error: assert 'lief analysis failed' in str(error)
    else: raise AssertionError('Parser errors must never masquerade as missing dependencies')
items, truncated = page(iter(range(10)), lambda x: x, 2)
assert items == [0, 1] and truncated
print('ok')
`;
  const result = spawnSync(python, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ok');
});

let probed;
test('real installed-library probe reports import evidence, without installing any package', { skip: !python, timeout: 30000 }, async t => {
  probed = await reverseToolchain(context, true);
  t.diagnostic(JSON.stringify(probed));
  assert.equal(probed.pythonFound, true);
  assert.ok(probed.python, probed.pythonError);
  for (const name of ['lief', 'pefile', 'pyelftools', 'capstone', 'pyghidra']) assert.equal(typeof probed.python.modules[name].available, 'boolean');
});

for (const engine of ['lief', 'pefile', 'pyelftools']) {
  test(`optional real ${engine} parser integration`, { skip: !python, timeout: 30000 }, async t => {
    if (!probed?.python?.modules?.[engine]?.available) return t.skip(`${engine} not installed; no real-engine verification claimed`);
    if ((engine === 'pefile' && process.platform !== 'win32') || (engine === 'pyelftools' && process.platform !== 'linux')) return t.skip('No matching native fixture on this platform');
    const fixture = path.join(temp, 'interpreter.bin');
    await fsp.copyFile(fs.realpathSync(python), fixture);
    const result = await inspectWithEngine(context, workspace, { path: 'interpreter.bin', engine, maxEntries: 10 });
    assert.equal(result.backend.engine, engine);
    assert.equal(result.backend.fallback, false);
    assert.ok(['PE', 'ELF', 'MACHO', 'MachO'].includes(result.format), result.format);
    assert.ok(Array.isArray(result.sections));
  });
}

test.after(async () => { await stopReverseEngines(); await fsp.rm(temp, { recursive: true, force: true }); });


test('CLI adapter pages structured results and emits only fixed read-only commands', async () => {
  const calls = [];
  const task = { async run(executable, args) {
    calls.push({ executable, args });
    return { stdout: args.includes('-v') ? 'rizin fixture-version' : '[{"offset":16},{"offset":32},{"offset":48}]', stderr: '', stderrTruncated: false };
  } };
  const result = await queryCli(task, 'rizin', 'rizin', 'sample.bin', { query: 'functions', offset: 1, limit: 1 }, 1000);
  assert.deepEqual(result.items, [{ offset: 32 }]);
  assert.equal(result.total, 3); assert.equal(result.nextOffset, 2); assert.equal(result.complete, false);
  assert.deepEqual(calls[1].args, ['-NN', '-q', '-e', 'scr.color=0', '-e', 'scr.interactive=false', '-c', 'aaa;aflj', 'sample.bin']);
});

test('CLI disassembly preserves precise address continuation and rejects malformed output', async () => {
  let output = '[{"offset":9007199254740993,"size":2}]';
  const task = { async run(_executable, args) { return { stdout: args.includes('-v') ? 'radare2 fixture-version' : output, stderr: '', stderrTruncated: false }; } };
  const args = { query: 'disassembly', address: '0x20000000000001', limit: 1 };
  const result = await queryCli(task, 'radare2', 'radare2', 'sample.bin', args, 1000);
  assert.equal(result.nextAddress, '0x20000000000003');
  assert.match(result.resultScope, /not the whole file/);
  output = '{}';
  await assert.rejects(queryCli(task, 'radare2', 'radare2', 'sample.bin', args, 1000), /unexpected result shape/);
});

test('missing code backends return actionable diagnostics instead of invented analysis', async () => {
  await assert.rejects(analyzeWithEngine(noEngines, workspace, { path: 'raw.bin', query: 'functions', engine: 'auto' }), /Ghidra.*rizin.*radare2.*JDK/);
});

test('Ghidra address adapter returns unambiguous unsigned hexadecimal addresses', { skip: !python }, () => {
  const code = ENGINE_PYTHON_SOURCE.replace("if __name__ == '__main__':", 'if False:') + String.raw`
class Address:
    def getOffset(self): return -1
assert ghidra_address(Address()) == '0xffffffffffffffff'
print('ok')
`;
  const result = spawnSync(python, ['-I', '-B', '-c', code], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ok');
});
