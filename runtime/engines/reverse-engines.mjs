import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeCommand } from '../platform/command-process.mjs';
import { engineEnvironment as sharedEngineEnvironment } from './engine-io.mjs';
import { pythonExecutable } from './reverse-native.mjs';
import { readBinary } from './reverse-files.mjs';
import { entropy, inspectFormat } from './reverse-formats.mjs';
import { hexAddress } from './reverse-values.mjs';
import { PARSER_SOURCE } from './reverse-parser-source.mjs';
import { GHIDRA_SOURCE } from './reverse-ghidra-source.mjs';

export const ENGINE_PYTHON_SOURCE = PARSER_SOURCE + GHIDRA_SOURCE + String.raw`
def json_safe(value):
    if isinstance(value, int) and abs(value) > 9007199254740991: return str(value)
    if isinstance(value, dict): return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [json_safe(v) for v in value]
    return value

if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    try:
        if request['operation'] == 'probe': result = {'pythonVersion': sys.version.split()[0], 'modules': {name: module_info(name) for name in MODULES}}
        elif request['operation'] == 'inspect': result = inspect_binary(request)
        else: result = ghidra_query(request)
        response = json.dumps({'ok': True, 'result': json_safe(result)}, ensure_ascii=True, allow_nan=False)
        if len(response.encode('utf-8')) > 2097152: raise ValueError('Engine response exceeds 2 MiB; request fewer entries')
    except Exception as error:
        response = json.dumps({'ok': False, 'error': type(error).__name__ + ': ' + str(error)[:4000]}, ensure_ascii=True)
    pathlib.Path(request['output']).write_text(response, encoding='utf-8')
`;

export function createReverseEngineState() { return { active: new Map(), closing: false, unconfirmed: [] }; }
const OUTPUT_LIMIT = 2 * 1024 * 1024;
const CLI = { rizin: { setting: 'rizinPath', names: ['rizin'] }, radare2: { setting: 'radare2Path', names: ['radare2', 'r2'] } };
export const ENGINE_GUIDANCE = Object.freeze({
  lief: 'Install the optional lief package in the Python selected by pythonPath; preferred PE/ELF/Mach-O parser.',
  pefile: 'Optional pefile package in the same Python; PE-only alternative to LIEF.',
  pyelftools: 'Optional pyelftools package in the same Python; ELF-only alternative to LIEF.',
  capstone: 'Optional capstone package in the same Python; used by reverse.disassemble.',
  rizin: 'Install Rizin separately and set rizinPath to its executable, or place it on PATH. Alternative: radare2.',
  radare2: 'Install radare2 separately and set radare2Path to its executable, or place it on PATH. Alternative: Rizin.',
  pyghidra: 'Install PyGhidra 3+ in the configured Python and set ghidraInstallDir to Ghidra 12+. A compatible JDK is also required. No decompiler is emulated when missing.'
});

function assertExecution(context, signal) {
  signal?.throwIfAborted();
  // Installed backends are the owner's programs; they parse project bytes and never change the project.
  context.assertOwner('Running an installed reverse-engineering backend');
  context.assertActive();
  if (context.state.engines.closing) throw new Error('Reverse external engine is closed');
}

export function engineEnvironment(scratch, source = process.env) {
  // The shared engine allow-list, with every per-user location pointed at the scratch
  // directory: no project or user RC files, Python paths, preload options or credentials.
  return { ...sharedEngineEnvironment({}, source), HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch, XDG_CONFIG_HOME: scratch, XDG_CACHE_HOME: scratch, TEMP: scratch, TMP: scratch, TMPDIR: scratch };
}

async function engineTask(context, operation, work) {
  const state = context.state.engines;
  assertExecution(context);
  if (state.active.size >= 2) throw new Error('Reverse engine capacity reached (2 concurrent operations)');
  const controller = new AbortController();
  const inherited = context.signal;
  const signal = inherited ? AbortSignal.any([inherited, controller.signal]) : controller.signal;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  state.active.set(controller, done);
  let scratch;
  try {
    await context.audit('engine_intent', { operation });
    assertExecution(context, signal);
    scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-reverse-engine-'));
    await fsp.chmod(scratch, 0o700);
    const run = async (executable, args, timeoutMs = context.settings.analysisTimeoutMs) => {
      assertExecution(context, signal);
      context.executables.assertAllowed(executable);
      const result = await executeCommand(executable, args, { cwd: scratch, shell: false, environment: engineEnvironment(scratch), timeoutMs, maxOutputChars: OUTPUT_LIMIT, signal });
      if (result.exitConfirmed === false) state.unconfirmed.push({ operation, executable, pid: result.pid || null });
      if (result.timedOut || result.exitConfirmed === false) throw new Error('Reverse engine timed out or did not confirm exit; no analysis result is accepted');
      if (result.error || result.exitCode !== 0) throw new Error(`Reverse engine failed (${result.exitCode}): ${result.error || result.stderr.slice(-2000)}`);
      if (result.stdoutTruncated) throw new Error('Reverse engine output exceeded 2 MiB; narrow the query rather than accepting partial JSON');
      return result;
    };
    const result = await work({ scratch, run, signal });
    assertExecution(context, signal);
    await context.audit('engine_complete', { operation, backend: result?.backend?.engine });
    return result;
  } finally {
    try { if (scratch) await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    finally { state.active.delete(controller); finish(); }
  }
}

export async function stopReverseEngines(state) {
  state.closing = true;
  const pending = [...state.active.entries()];
  for (const [controller] of pending) controller.abort(new Error('Reverse engine stopped'));
  await Promise.all(pending.map(([, done]) => done));
  if (state.unconfirmed.length) throw new Error('An owned reverse engine did not confirm process exit; inspect this instance before discarding its state.');
}

function cliExecutable(context, engine) {
  const entry = CLI[engine];
  if (!entry) throw new Error('Unsupported CLI engine');
  const configured = context.settings[entry.setting];
  if (configured && !path.isAbsolute(configured)) throw new Error(`${entry.setting} must be an absolute executable path`);
  const executable = context.executables.find(configured ? [configured] : entry.names);
  if (executable) {
    const expected = engine === 'rizin' ? /^rizin(?:\.exe)?$/i : /^(?:radare2|r2)(?:\.exe)?$/i;
    if (!expected.test(path.basename(executable))) throw new Error(`Expected a native ${engine} executable, not a different engine or shell wrapper`);
    context.executables.assertAllowed(executable);
  }
  return executable;
}

function ghidraInstallation(context) {
  const directory = context.settings.ghidraInstallDir;
  if (!directory || !path.isAbsolute(directory)) throw new Error('Set ghidraInstallDir to the absolute Ghidra installation directory');
  const canonical = fs.realpathSync(directory);
  if (!fs.statSync(path.join(canonical, 'Ghidra', 'application.properties'), { throwIfNoEntry: false })?.isFile()) throw new Error('ghidraInstallDir does not contain Ghidra/application.properties');
  return canonical;
}

async function pythonCall(context, task, request) {
  const output = path.join(task.scratch, 'result.json');
  await fsp.rm(output, { force: true });
  const args = JSON.stringify({ ...request, output, scratch: task.scratch });
  await task.run(pythonExecutable(context), ['-I', '-B', '-c', ENGINE_PYTHON_SOURCE, args], request.operation === 'probe' ? context.settings.nativeTimeoutMs : context.settings.analysisTimeoutMs);
  const stat = await fsp.lstat(output);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > OUTPUT_LIMIT) throw new Error('Invalid or oversized engine result file');
  const response = JSON.parse(await fsp.readFile(output, 'utf8'));
  if (response.ok !== true) throw new Error(response.error || 'Invalid backend response');
  if (!response.result || typeof response.result !== 'object') throw new Error('Invalid backend result');
  return response.result;
}

async function snapshot(task, input) {
  const filename = path.join(task.scratch, 'sample.bin');
  await fsp.writeFile(filename, input.bytes, { flag: 'wx', mode: 0o600 });
  return filename;
}

export async function reverseToolchain(context, probe = false) {
  const result = { engines: {}, guidance: ENGINE_GUIDANCE, automaticInstallation: false, probeRequested: probe };
  try { pythonExecutable(context); result.pythonFound = true; } catch (error) { result.pythonFound = false; result.pythonError = error.message; }
  for (const engine of Object.keys(CLI)) {
    try { result.engines[engine] = { found: !!cliExecutable(context, engine), verified: 'not probed' }; }
    catch (error) { result.engines[engine] = { found: false, error: error.message, verified: 'not probed' }; }
  }
  try { ghidraInstallation(context); result.ghidraInstallationFound = true; }
  catch (error) { result.ghidraInstallationFound = false; result.ghidraError = error.message; }
  if (!probe) return result;
  if (context.caller() !== 'owner') return { ...result, probeError: 'Probes run the installed backends, which only the owner may do' };
  return engineTask(context, 'toolchain_probe', async task => {
    if (result.pythonFound) {
      try { result.python = await pythonCall(context, task, { operation: 'probe' }); }
      catch (error) { result.pythonError = error.message; }
    }
    for (const engine of Object.keys(CLI)) {
      if (!result.engines[engine].found) continue;
      try {
        const output = await task.run(cliExecutable(context, engine), ['-NN', '-v'], context.settings.nativeTimeoutMs);
        const version = output.stdout.trim().slice(0, 500);
        if (!version.toLowerCase().includes(engine)) throw new Error('Unexpected version response');
        result.engines[engine] = { found: true, available: true, version, verified: 'version only; not an analysis test' };
      } catch (error) { result.engines[engine] = { found: true, available: false, error: error.message }; }
    }
    return result;
  });
}

export function binaryKind(bytes) {
  if (bytes.subarray(0, 2).toString('ascii') === 'MZ') return 'PE';
  const magic = bytes.subarray(0, 4).toString('hex');
  if (magic === '7f454c46') return 'ELF';
  if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic)) return 'Mach-O candidate';
  return 'raw';
}

export async function inspectWithEngine(context, workspace, args) {
  const input = await readBinary(context, workspace, args.path);
  const engine = args.engine || context.settings.binaryEngine || 'auto';
  const limit = args.maxEntries ?? 1000;
  const common = { path: args.path, size: input.size, sha256: input.sha256, entropy: entropy(input.bytes) };
  const fallback = (reason, diagnostics = []) => {
    if (engine !== 'builtin' && context.settings.allowBuiltinFallback === false) throw new Error(`Mature parser unavailable: ${reason}. reverse.toolchain shows setup guidance`);
    return { ...common, ...inspectFormat(input.bytes, limit), backend: { engine: 'builtin', version: '0.1.0', fallback: engine !== 'builtin', reason }, diagnostics, guidance: ENGINE_GUIDANCE };
  };
  if (engine === 'builtin') return fallback('Explicitly selected limited built-in parser');
  if (engine === 'auto' && binaryKind(input.bytes) === 'raw') return fallback('Raw or unrecognized data; use byte/value tools, or select a parser explicitly');
  if (engine === 'auto' && context.caller() !== 'owner') return fallback('Installed parsers run only for the owner of this DevMate runtime');
  try { pythonExecutable(context); }
  catch (error) { if (engine === 'auto') return fallback(error.message); throw error; }
  const result = await engineTask(context, 'binary_inspect', async task => pythonCall(context, task, { operation: 'inspect', input: await snapshot(task, input), engine, limit }));
  if (!result.available) {
    if (engine !== 'auto') throw new Error(`${engine} unavailable: ${JSON.stringify(result.diagnostics)}. ${ENGINE_GUIDANCE[engine]}`);
    return fallback(result.reason, result.diagnostics);
  }
  return { ...common, ...result };
}

export function codeCommand(query, { address, limit = 200 } = {}) {
  const fixed = { functions: 'aaa;aflj', symbols: 'isj', imports: 'iij', exports: 'iEj', sections: 'iSj' };
  if (Object.hasOwn(fixed, query)) return fixed[query];
  const at = hexAddress(address);
  if (query === 'xrefs') return `aaa;axtj @ ${at}`;
  if (query === 'disassembly') {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid instruction limit');
    return `pdj ${limit} @ ${at}`;
  }
  throw new Error('Unsupported code query');
}

export function parseEngineJson(text) {
  // Node 24 exposes the original primitive source in the JSON reviver.
  return JSON.parse(text.trim(), (_key, value, context) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?[0-9]+$/.test(context.source)) throw new Error('Unsafe engine numeric value');
      return context.source;
    }
    return value;
  });
}

export async function queryCli(task, executable, engine, filename, args, probeTimeoutMs) {
  const version = (await task.run(executable, ['-NN', '-v'], probeTimeoutMs)).stdout.trim().slice(0, 500);
  if (!version.toLowerCase().includes(engine)) throw new Error(`Unexpected ${engine} version response`);
  const output = await task.run(executable, ['-NN', '-q', '-e', 'scr.color=0', '-e', 'scr.interactive=false', '-c', codeCommand(args.query, args), filename]);
  const all = parseEngineJson(output.stdout);
  if (!Array.isArray(all)) throw new Error(`${engine} returned an unexpected result shape; no fallback is substituted`);
  const offset = args.offset || 0, limit = args.limit || 200;
  const items = all.slice(offset, offset + limit), nextOffset = offset + items.length < all.length ? offset + items.length : null;
  const result = { backend: { engine, version, fallback: false }, items, total: all.length, offset, nextOffset, complete: nextOffset === null, warnings: output.stderr.slice(-2000), warningsTruncated: output.stderrTruncated, coverage: 'Backend analysis only; not proof that every function/reference was found' };
  if (args.query === 'disassembly') {
    const last = items.at(-1);
    result.resultScope = 'requested instruction window, not the whole file';
    result.nextAddress = last && last.offset !== undefined && Number.isInteger(last.size) && last.size > 0 ? hexAddress((BigInt(last.offset) + BigInt(last.size)).toString()) : null;
  }
  return result;
}

export async function analyzeWithEngine(context, workspace, args) {
  const query = args.query || 'decompile';
  if (['xrefs', 'disassembly', 'decompile'].includes(query) && args.address === undefined) throw new Error(`${query} requires an explicit address`);
  const requested = args.engine || 'auto';
  const diagnostics = [];
  return engineTask(context, query, async task => {
    const input = await readBinary(context, workspace, args.path);
    const filename = await snapshot(task, input);
    const common = { path: args.path, sourceSha256: input.sha256, query };
    if (requested !== 'ghidra' && query !== 'decompile') {
      for (const engine of requested === 'auto' ? ['rizin', 'radare2'] : [requested]) {
        const executable = cliExecutable(context, engine);
        if (!executable) { diagnostics.push({ engine, reason: 'executable not found' }); continue; }
        const result = await queryCli(task, executable, engine, filename, args, context.settings.nativeTimeoutMs);
        return { ...common, ...result, diagnostics };
      }
    }
    if ((requested === 'auto' || requested === 'ghidra') && ['functions', 'xrefs', 'decompile'].includes(query)) {
      let installation;
      try { installation = ghidraInstallation(context); pythonExecutable(context); }
      catch (error) { throw new Error(`No usable Ghidra backend: ${error.message}. Other candidates: ${JSON.stringify(diagnostics)}. ${ENGINE_GUIDANCE.pyghidra}`); }
      const result = await pythonCall(context, task, { operation: query, input: filename, ghidraInstallDir: installation, address: args.address === undefined ? undefined : hexAddress(args.address), limit: args.limit || 200, offset: args.offset || 0, analysisSeconds: args.analysisSeconds || 60, decompileSeconds: args.decompileSeconds || 30, maxChars: args.maxChars || 30000 });
      return { ...common, ...result, diagnostics };
    }
    throw new Error(`No installed backend for ${query}: ${JSON.stringify(diagnostics)}. ${ENGINE_GUIDANCE.rizin} ${ENGINE_GUIDANCE.radare2}`);
  });
}

export const __test = { activeCount: state => state.active.size, engineTask, cliExecutable, ghidraInstallation, OUTPUT_LIMIT };
